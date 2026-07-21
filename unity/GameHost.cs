using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using UnityEngine;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using NativeWebSocket;

// IMPORTANTE: Para WebGL necesitas instalar el paquete NativeWebSocket:
// En Unity, ve a Window > Package Manager > Add package from git URL...
// Ingresa: https://github.com/endel/NativeWebSocket.git#upm
public class GameHost : MonoBehaviour
{
    [Header("Configuration")]
    public string wsUrl = "wss://tu-api-id.execute-api.region.amazonaws.com/stage";
    public int maxPlayers = 4;
    public float turnTimeoutSeconds = 5.0f;

    // Events
    public event Action<string> OnReady;
    public event Action<string> OnJoin;
    public event Action<string> OnLeave;
    public event Action<Dictionary<string, JToken>> OnMoves;
    public event Action<string, string> OnMessage;

    // State
    public string Id { get; private set; }
    private WebSocket ws;
    
    private List<string> guests = new List<string>();
    private Dictionary<string, JToken> currentTurnMoves = new Dictionary<string, JToken>();
    private JToken hostMoveData = null;

    private float turnTimer = 0f;
    private bool isTurnActive = false;

    private void Update()
    {
        if (ws != null)
        {
#if !UNITY_WEBGL || UNITY_EDITOR
            // En plataformas nativas o el Editor, despacha los mensajes al hilo principal
            ws.DispatchMessageQueue();
#endif
        }

        // Handle turn timer
        if (isTurnActive)
        {
            turnTimer -= Time.deltaTime;
            if (turnTimer <= 0)
            {
                ResolveTurn();
            }
        }
    }

    private async void OnApplicationQuit()
    {
        if (ws != null)
        {
            await ws.Close();
        }
    }

    public async void Connect()
    {
        ws = new WebSocket(wsUrl);

        ws.OnOpen += () =>
        {
            // Request ID
            SendMessage(new { action = "get_id" });
        };

        ws.OnError += (errMsg) => Debug.LogError($"WebSocket Error: {errMsg}");
        ws.OnClose += (closeCode) => Debug.Log("WebSocket Closed");
        
        ws.OnMessage += (bytes) =>
        {
            string json = Encoding.UTF8.GetString(bytes);
            JObject data = JObject.Parse(json);
            string type = data["type"]?.ToString();

            if (type == "your_id")
            {
                Id = data["id"].ToString();
                OnReady?.Invoke(Id);
                StartTurnTimer();
            }
            else if (type == "join")
            {
                string guestId = data["guestId"].ToString();
                HandleJoinRequest(guestId);
            }
            else if (type == "move")
            {
                string guestId = data["guestId"].ToString();
                JToken moveData = data["moveData"];
                HandleMove(guestId, moveData);
            }
            else if (type == "direct_message")
            {
                string msg = data["message"].ToString();
                string senderId = data["senderId"].ToString();
                OnMessage?.Invoke(msg, senderId);
            }
        };

        await ws.Connect();
    }

    public async void Disconnect()
    {
        if (ws != null && ws.State == WebSocketState.Open)
        {
            await ws.Close();
        }
    }

    public List<string> GetPlayers()
    {
        var players = new List<string> { Id };
        players.AddRange(guests);
        return players;
    }

    public void Move(object moveData)
    {
        hostMoveData = JToken.FromObject(moveData);
        CheckTurnResolution();
    }

    public void SendDirectMessage(object message, List<string> targets = null)
    {
        if (targets == null || targets.Count == 0)
        {
            targets = new List<string>(guests);
        }

        if (targets.Count > 0)
        {
            SendMessage(new
            {
                action = "route",
                targets = targets,
                payload = new
                {
                    type = "direct_message",
                    senderId = Id,
                    message = message
                }
            });
        }
    }

    private void HandleJoinRequest(string guestId)
    {
        if (guests.Count >= maxPlayers - 1) return;

        guests.Add(guestId);
        currentTurnMoves[guestId] = null; // Free pass for current turn

        // Send confirm
        SendMessage(new
        {
            action = "route",
            targets = new[] { guestId },
            payload = new { type = "confirm_join", hostId = Id, guests = guests }
        });

        // Notify others
        var otherGuests = guests.Where(g => g != guestId).ToList();
        if (otherGuests.Count > 0)
        {
            SendMessage(new
            {
                action = "route",
                targets = otherGuests,
                payload = new { type = "guest_joined", newGuestId = guestId }
            });
        }

        OnJoin?.Invoke(guestId);
        CheckTurnResolution();
    }

    private void HandleMove(string guestId, JToken moveData)
    {
        if (!guests.Contains(guestId)) return;
        currentTurnMoves[guestId] = moveData;
        CheckTurnResolution();
    }

    private void StartTurnTimer()
    {
        turnTimer = turnTimeoutSeconds;
        isTurnActive = true;
    }

    private void CheckTurnResolution()
    {
        bool allGuestsMoved = guests.All(g => currentTurnMoves.ContainsKey(g) && currentTurnMoves[g] != null);
        if (allGuestsMoved && hostMoveData != null)
        {
            ResolveTurn();
        }
    }

    private void ResolveTurn()
    {
        isTurnActive = false;

        // 1. Kick inactive
        var inactiveGuests = guests.Where(g => !currentTurnMoves.ContainsKey(g) || currentTurnMoves[g] == null).ToList();
        foreach (var guestId in inactiveGuests)
        {
            RemoveGuest(guestId);
        }

        // 2. Compile moves
        var allMoves = new Dictionary<string, JToken>();
        allMoves[Id] = hostMoveData;
        foreach (var kvp in currentTurnMoves)
        {
            allMoves[kvp.Key] = kvp.Value;
        }

        // 3. Notify remaining guests
        if (guests.Count > 0)
        {
            SendMessage(new
            {
                action = "route",
                targets = guests,
                payload = new { type = "turn_moves", moves = allMoves }
            });
        }

        // 4. Trigger callback
        OnMoves?.Invoke(allMoves);

        // 5. Reset
        currentTurnMoves.Clear();
        foreach (var g in guests) currentTurnMoves[g] = null; // Re-init dictionary for next turn
        hostMoveData = null;
        StartTurnTimer();
    }

    private void RemoveGuest(string guestId)
    {
        guests.Remove(guestId);
        
        SendMessage(new
        {
            action = "route",
            targets = new[] { guestId },
            payload = new { type = "kicked" }
        });

        if (guests.Count > 0)
        {
            SendMessage(new
            {
                action = "route",
                targets = guests,
                payload = new { type = "guest_left", leftGuestId = guestId }
            });
        }

        OnLeave?.Invoke(guestId);
    }

    private async void SendMessage(object payload)
    {
        if (ws == null || ws.State != WebSocketState.Open) return;

        string json = JsonConvert.SerializeObject(payload);
        await ws.SendText(json);
    }
}
