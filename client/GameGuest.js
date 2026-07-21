export class GameGuest {
  constructor(config = {}) {
    this.wsUrl = config.wsUrl;
    
    // Callbacks
    this.onJoined = config.onJoined || (() => {}); // Fired when host confirms join
    this.onLeave = config.onLeave || (() => {});   // Fired when kicked or host leaves
    this.onMoves = config.onMoves || (() => {});   // Fired on turn resolution
    this.onReady = config.onReady || (() => {});   // Fired when guest gets its ID
    this.onMessage = config.onMessage || (() => {}); // Fired on direct messages

    this.id = null;
    this.hostId = null;
    this.ws = null;
    this.connectedHost = false;
    this.guests = []; // List of all guests in the room including us
    
    this.autoMoveTimeout = config.autoMoveTimeout || 3000;
    this.moveTimer = null;
  }

  connect() {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.onopen = () => {
      // Request connection ID
      this.ws.send(JSON.stringify({ action: 'get_id' }));
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'your_id') {
        this.id = data.id;
        this.onReady(this.id);
      } else if (data.type === 'confirm_join') {
        this.connectedHost = true;
        this.guests = data.guests;
        this.onJoined(data.hostId, data.guests);
        this.startAutoMoveTimer();
      } else if (data.type === 'guest_joined') {
        this.guests.push(data.newGuestId);
        // Another guest joined (optional handling)
        console.log(`Guest ${data.newGuestId} joined the room.`);
      } else if (data.type === 'guest_left') {
        this.guests = this.guests.filter(g => g !== data.leftGuestId);
        // Another guest left (optional handling)
        console.log(`Guest ${data.leftGuestId} left the room.`);
      } else if (data.type === 'turn_moves') {
        this.onMoves(data.moves);
        this.startAutoMoveTimer();
      } else if (data.type === 'kicked') {
        this.connectedHost = false;
        this.hostId = null;
        this.guests = [];
        if (this.moveTimer) clearTimeout(this.moveTimer);
        this.onLeave();
      } else if (data.type === 'direct_message') {
        this.onMessage(data.message, data.senderId);
      }
    };
  }

  startAutoMoveTimer() {
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = setTimeout(() => {
      // Send an empty move to stay alive
      this.move(null);
    }, this.autoMoveTimeout);
  }

  getPlayers() {
    if (!this.connectedHost) return [];
    return [this.hostId, ...this.guests];
  }

  send(message, targets) {
    if (!this.connectedHost) return;
    
    if (!targets) {
      // Send to host and all other guests
      targets = [this.hostId, ...this.guests.filter(g => g !== this.id)];
    }
    
    if (targets.length > 0) {
      this._sendMessage(targets, { type: 'direct_message', senderId: this.id, message: message });
    }
  }

  join(hostId) {
    if (!this.id) {
      console.error("Not ready. Wait for onReady callback.");
      return;
    }
    this.hostId = hostId;
    this._sendMessage(this.hostId, { type: 'join', guestId: this.id });
  }

  leave() {
    if (this.hostId && this.connectedHost) {
      this.connectedHost = false;
      if (this.moveTimer) clearTimeout(this.moveTimer);
      this.onLeave();
      // We don't necessarily send a leave message to the host since the host
      // removes guests that timeout, but we could add it as an optimization later.
    }
  }

  move(moveData) {
    if (!this.hostId || !this.connectedHost) {
      console.error("Not connected to a host.");
      return;
    }
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this._sendMessage(this.hostId, { type: 'move', guestId: this.id, moveData });
  }

  _sendMessage(targets, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    
    this.ws.send(JSON.stringify({
      action: 'route',
      targets: targets,
      payload: payload
    }));
  }
}
