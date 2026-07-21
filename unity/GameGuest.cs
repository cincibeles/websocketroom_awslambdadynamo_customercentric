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
public class GameGuest : MonoBehaviour
{
    [Header("Configuration")]
    public string wsUrl = "wss://tu-api-id.execute-api.region.amazonaws.com/stage";
    public float autoMoveTimeoutSeconds = 3.0f;

    // Events
    public event Action<string> OnReady;
    public event Action<string, List<string>> OnJoined;
    public event Action OnLeave;
    public event Action<Dictionary<string, JToken>> OnMoves;
    public event Action<string, string> OnMessage;

    // State
    public string Id { get; private set; }
    public string HostId { get; private set; }
    private bool connectedHost = false;
    private List<string> guests = new List<string>();

    private WebSocket ws;

    private float autoMoveTimer = 0f;
    private bool isAutoMoveTimerActive = false;

    private void Update()
    {
        if (ws != null)
        {
#if !UNITY_WEBGL || UNITY_EDITOR
            // En plataformas nativas o el Editor, despacha los mensajes al hilo principal
            ws.DispatchMessageQueue();
#endif
        }

        // Handle auto-move timer
        if (isAutoMoveTimerActive)
        {
            autoMoveTimer -= Time.deltaTime;
            if (autoMoveTimer <= 0)
            {
                isAutoMoveTimerActive = false;
                Move(null); // Send empty move to stay alive
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
            }
            else if (type == "confirm_join")
            {
                connectedHost = true;
                HostId = data["hostId"].ToString();
                guests = data["guests"].ToObject<List<string>>();
                
                OnJoined?.Invoke(HostId, guests);
                StartAutoMoveTimer();
            }
            else if (type == "guest_joined")
            {
                string newGuestId = data["newGuestId"].ToString();
                guests.Add(newGuestId);
                Debug.Log($"Guest {newGuestId} joined the room.");
            }
            else if (type == "guest_left")
            {
                string leftGuestId = data["leftGuestId"].ToString();
                guests.Remove(leftGuestId);
                Debug.Log($"Guest {leftGuestId} left the room.");
            }
            else if (type == "turn_moves")
            {
                var moves = data["moves"].ToObject<Dictionary<string, JToken>>();
                OnMoves?.Invoke(moves);
                StartAutoMoveTimer();
            }
            else if (type == "kicked")
            {
                connectedHost = false;
                HostId = null;
                guests.Clear();
                isAutoMoveTimerActive = false;
                OnLeave?.Invoke();
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

    public void Join(string hostId)
    {
        if (string.IsNullOrEmpty(Id))
        {
            Debug.LogError("Not ready. Wait for OnReady callback.");
            return;
        }

        HostId = hostId;
        SendMessage(new
        {
            action = "route",
            targets = new[] { HostId },
            payload = new { type = "join", guestId = Id }
        });
    }

    public void Leave()
    {
        if (!string.IsNullOrEmpty(HostId) && connectedHost)
        {
            connectedHost = false;
            isAutoMoveTimerActive = false;
            OnLeave?.Invoke();
        }
    }

    public void Move(object moveData)
    {
        if (string.IsNullOrEmpty(HostId) || !connectedHost)
        {
            Debug.LogError("Not connected to a host.");
            return;
        }

        isAutoMoveTimerActive = false; // Cancel auto-move

        SendMessage(new
        {
            action = "route",
            targets = new[] { HostId },
            payload = new { type = "move", guestId = Id, moveData = moveData }
        });
    }

    public List<string> GetPlayers()
    {
        if (!connectedHost) return new List<string>();
        var players = new List<string> { HostId };
        players.AddRange(guests);
        return players;
    }

    public void SendDirectMessage(object message, List<string> targets = null)
    {
        if (!connectedHost) return;

        if (targets == null || targets.Count == 0)
        {
            targets = new List<string> { HostId };
            targets.AddRange(guests.Where(g => g != Id));
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

    private void StartAutoMoveTimer()
    {
        autoMoveTimer = autoMoveTimeoutSeconds;
        isAutoMoveTimerActive = true;
    }

    private async void SendMessage(object payload)
    {
        if (ws == null || ws.State != WebSocketState.Open) return;

        string json = JsonConvert.SerializeObject(payload);
        await ws.SendText(json);
    }
}
