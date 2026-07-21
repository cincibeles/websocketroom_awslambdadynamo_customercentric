export class GameHost {
  constructor(config = {}) {
    this.wsUrl = config.wsUrl;
    this.maxPlayers = config.maxPlayers || 4;
    this.turnTimeout = config.turnTimeout || 5000;
    
    // Callbacks
    this.onJoin = config.onJoin || (() => {});
    this.onLeave = config.onLeave || (() => {});
    this.onMoves = config.onMoves || (() => {});
    this.onReady = config.onReady || (() => {}); // Fired when host gets its ID
    this.onMessage = config.onMessage || (() => {}); // Fired on direct messages

    this.id = null;
    this.ws = null;
    this.guests = []; // Array of guest connection IDs
    this.currentTurnMoves = {}; // guestId -> moveData
    this.hostMoveData = null; // The host's move for the current turn
    this.turnTimer = null;
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
        this.startTurnTimer(); // Start the first turn
      } else if (data.type === 'join') {
        this.handleJoinRequest(data.guestId);
      } else if (data.type === 'move') {
        this.handleMove(data.guestId, data.moveData);
      } else if (data.type === 'direct_message') {
        this.onMessage(data.message, data.senderId);
      }
    };
  }

  getId() {
    return this.id;
  }

  getPlayers() {
    return [this.id, ...this.guests];
  }

  send(message, targets) {
    if (!targets) {
      targets = this.guests;
    }
    
    if (targets.length > 0) {
      this._sendMessage(targets, { type: 'direct_message', senderId: this.id, message: message });
    }
  }

  // A method for the host to register its own move
  move(moveData) {
    this.hostMoveData = moveData;
    this.checkTurnResolution();
  }

  handleJoinRequest(guestId) {
    if (this.guests.length >= this.maxPlayers - 1) { // -1 because host is also a player
      // Ignore or send reject
      return;
    }

    // Add guest
    this.guests.push(guestId);
    
    // Give the new guest a free pass for the current turn so the timer doesn't kick them
    this.currentTurnMoves[guestId] = null; 
    
    // Send confirmation to the new guest
    this._sendMessage(guestId, { type: 'confirm_join', hostId: this.id, guests: this.guests });
    
    // Notify everyone else that a new guest joined
    const otherGuests = this.guests.filter(g => g !== guestId);
    if (otherGuests.length > 0) {
      this._sendMessage(otherGuests, { type: 'guest_joined', newGuestId: guestId });
    }

    this.onJoin(guestId);
    this.checkTurnResolution(); // Check if this join resolves the turn
  }

  handleMove(guestId, moveData) {
    if (!this.guests.includes(guestId)) return;
    
    this.currentTurnMoves[guestId] = moveData;
    this.checkTurnResolution();
  }

  startTurnTimer() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    
    this.turnTimer = setTimeout(() => {
      this.resolveTurn(); // Resolve turn even if not everyone moved
    }, this.turnTimeout);
  }

  checkTurnResolution() {
    // Check if we have moves from all guests AND the host
    const allGuestsMoved = this.guests.every(guestId => this.currentTurnMoves[guestId] !== undefined);
    if (allGuestsMoved && this.hostMoveData !== null) {
      this.resolveTurn();
    }
  }

  resolveTurn() {
    if (this.turnTimer) clearTimeout(this.turnTimer);

    // 1. Kick guests who didn't move
    const inactiveGuests = this.guests.filter(guestId => this.currentTurnMoves[guestId] === undefined);
    
    inactiveGuests.forEach(guestId => {
      this.removeGuest(guestId);
    });

    // 2. Compile all moves
    const allMoves = {
      [this.id]: this.hostMoveData || null, // Allow empty move if host didn't move
      ...this.currentTurnMoves
    };

    // 3. Notify all remaining guests
    if (this.guests.length > 0) {
      this._sendMessage(this.guests, { type: 'turn_moves', moves: allMoves });
    }

    // 4. Trigger callback
    this.onMoves(allMoves);

    // 5. Reset for next turn
    this.currentTurnMoves = {};
    this.hostMoveData = null;
    this.startTurnTimer();
  }

  removeGuest(guestId) {
    this.guests = this.guests.filter(g => g !== guestId);
    this._sendMessage(guestId, { type: 'kicked' }); // Attempt to tell them they were kicked
    
    if (this.guests.length > 0) {
      this._sendMessage(this.guests, { type: 'guest_left', leftGuestId: guestId });
    }
    
    this.onLeave(guestId);
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
