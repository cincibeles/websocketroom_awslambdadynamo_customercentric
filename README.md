# Serverless Multiplayer Game via WebSockets

Este sistema permite construir un juego multijugador sin la necesidad de utilizar una base de datos o de mantener el estado de la partida dentro de los servidores. Toda la lógica de enrutamiento corre en una función de **AWS Lambda** que interactúa con el **API Gateway WebSockets**, mientras que la lógica de juego y el estado de la partida recaen por completo en el lado del cliente, específicamente bajo la administración del **Anfitrión (Host)**.

## Arquitectura

El sistema funciona de la siguiente manera:
1. **Lambda & API Gateway:** Funcionan puramente como un enrutador de mensajes. Cuando un cliente se conecta, se le asigna un `connectionId`. Los clientes envían cargas (payloads) indicando los destinatarios, y la Lambda los reenvía usando el `ApiGatewayManagementApi`.
2. **Cliente Anfitrión (GameHost):** Es el jugador que crea la partida. Se encarga de aceptar a los invitados, recolectar los movimientos (incluyendo el propio), mantener los tiempos de turno y retransmitir los resultados al resto.
3. **Cliente Invitado (GameGuest):** Son los jugadores que se unen a una partida compartida por un anfitrión usando su ID. Envían sus movimientos al anfitrión y esperan la resolución de los turnos.

---

## Configuración y Despliegue de AWS

1. **API Gateway (WebSocket):**
   - Crea un API WebSocket en AWS.
   - Crea las rutas: `$connect`, `$disconnect`, `get_id`, y `route`.
   - Conecta cada ruta a tu función Lambda.

2. **AWS Lambda:**
   - Despliega el contenido de `index.mjs`.
   - Asegúrate de darle permisos a tu rol de Lambda para ejecutar llamadas al API Gateway Management API (política `execute-api:ManageConnections`).

---

## Uso del Cliente Anfitrión (GameHost)

El **Anfitrión** es el motor central del juego. Para comenzar una partida, debes instanciar la clase y compartir el ID resultante con los invitados.

### Instanciación y Conexión

```javascript
import { GameHost } from './GameHost.js';

const host = new GameHost({
    wsUrl: 'wss://tu-api-id.execute-api.region.amazonaws.com/stage',
    maxPlayers: 4,         // Límite de jugadores en la sala
    turnTimeout: 5000,     // Tiempo en ms para resolver automáticamente el turno (5 segundos)
    
    // Callbacks
    onReady: (id) => {
        console.log(`Anfitrión listo. Comparte este ID con los invitados: ${id}`);
    },
    onJoin: (guestId) => {
        console.log(`El invitado ${guestId} se ha unido a la partida.`);
    },
    onLeave: (guestId) => {
        console.log(`El invitado ${guestId} ha sido desconectado o abandonó la partida.`);
    },
    onMoves: (moves) => {
        // 'moves' es un objeto que contiene los IDs de los jugadores (incluyendo al host) y sus movimientos
        console.log(`Resolución de turno:`, moves);
    },
    onMessage: (message, senderId) => {
        console.log(`Mensaje directo de ${senderId}: ${message}`);
    }
});

host.connect();
```

### Métodos del Anfitrión

- `host.getId()`: Devuelve el Connection ID del anfitrión, en caso de necesitarlo después de que se disparó el callback `onReady`.
- `host.getPlayers()`: Devuelve un arreglo con los IDs de todos los jugadores en la sala, incluyendo al propio anfitrión.
- `host.move(moveData)`: Registra el movimiento o acción que realiza el propio anfitrión en el turno actual. Cuando el anfitrión y todos los invitados hayan movido (o termine el tiempo de `turnTimeout`), se resolverá el turno.
- `host.send(message, targets)`: Envía un mensaje directo. Si `targets` (un arreglo de IDs de conexión) no se provee o es nulo, envía el mensaje a todos los invitados.

---

## Uso del Cliente Invitado (GameGuest)

El **Invitado** se conecta al servicio y se enlaza a un Anfitrión mediante su ID. El invitado mantiene internamente una lista de todos los jugadores conectados.

### Instanciación y Conexión

```javascript
import { GameGuest } from './GameGuest.js';

const guest = new GameGuest({
    wsUrl: 'wss://tu-api-id.execute-api.region.amazonaws.com/stage',
    autoMoveTimeout: 3000, // Tiempo en ms (3s) para enviar automáticamente un movimiento vacío y evitar ser expulsado
    
    // Callbacks
    onReady: (id) => {
        console.log(`Invitado conectado con éxito. Mi ID es: ${id}`);
        // Una vez listos, podemos unirnos a un anfitrión
        // guest.join('ID_DEL_ANFITRION_AQUI');
    },
    onJoined: (hostId, guestsInRoom) => {
        console.log(`Unido exitosamente al anfitrión ${hostId}`);
    },
    onLeave: () => {
        console.log(`Hemos sido expulsados o abandonamos la partida.`);
    },
    onMoves: (moves) => {
        // Al igual que el Host, aquí se reciben las acciones de todos los jugadores de ese turno
        console.log(`Resolución de turno (recibido del Host):`, moves);
    },
    onMessage: (message, senderId) => {
        console.log(`Mensaje directo de ${senderId}: ${message}`);
    }
});

guest.connect();
```

### Métodos del Invitado

- `guest.getPlayers()`: Devuelve un arreglo con los IDs de todos los jugadores en la sala (incluyendo al host, a sí mismo y a otros invitados).
- `guest.join(hostId)`: Envía una solicitud de conexión a la sala del anfitrión usando el ID del anfitrión.
- `guest.move(moveData)`: Envía el movimiento actual (puede ser un objeto o string, por ejemplo `{x: 10, y: 20}`) al anfitrión. Esto además sirve como confirmación de vida ("alive").
- `guest.send(message, targets)`: Envía un mensaje directo. Si `targets` (un arreglo de IDs) es nulo, envía el mensaje a **todos** los jugadores (el anfitrión y el resto de los invitados, exceptuándose a sí mismo).
- `guest.leave()`: Desconecta intencionalmente al invitado de la partida del anfitrión.

---

## Flujo del Turno (Ciclo de Vida)

1. El temporizador empieza al inicio de la partida o al resolverse un turno anterior.
2. Cada jugador llama al método `move(data)`.
3. El anfitrión almacena estos movimientos temporalmente.
4. Si *todos* los jugadores (incluyendo el host) envían su movimiento antes del tiempo límite, el turno se resuelve inmediatamente.
5. Si pasa el tiempo límite (`turnTimeout`), el turno se resuelve con los movimientos recolectados hasta el momento. **Cualquier jugador (Guest) que no envió su movimiento es automáticamente expulsado del grupo por inactividad.**
6. El anfitrión emite `onMoves` y retransmite este mismo evento a todos los invitados restantes, reiniciando el ciclo para el siguiente turno.
