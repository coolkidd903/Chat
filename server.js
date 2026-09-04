// --- rooms support for fallback server ---
// Add these helpers & message handlers into your existing server.js WebSocket code.

// Data structures
// clients: Map(clientId -> ws)  // existing
// deliveryQueue: persistent offline queue (existing)
// rooms: Map(roomId -> Set(clientId))
const rooms = new Map();

// helper: join room
function joinRoom(clientId, roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(clientId);
  persistRooms();
}

// helper: leave room
function leaveRoom(clientId, roomId) {
  if (!rooms.has(roomId)) return;
  rooms.get(roomId).delete(clientId);
  if (rooms.get(roomId).size === 0) rooms.delete(roomId);
  persistRooms();
}

// persist rooms to disk (optional)
const ROOMS_FILE = path.join(__dirname, 'rooms.json');
function persistRooms(){
  try{
    const obj = {};
    rooms.forEach((set, id) => obj[id] = Array.from(set));
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(obj, null, 2));
  }catch(e){ console.warn('persistRooms err', e); }
}
function loadRooms(){
  try{
    if(fs.existsSync(ROOMS_FILE)){ const obj = JSON.parse(fs.readFileSync(ROOMS_FILE,'utf8')||'{}'); Object.keys(obj).forEach(r=> rooms.set(r, new Set(obj[r]||[]))); }
  }catch(e){ console.warn('loadRooms err', e); }
}
loadRooms();

// Broadcast to all clients in a room (optionally exclude sender)
function broadcastToRoom(roomId, messageObj, excludeClientId=null){
  const set = rooms.get(roomId);
  if(!set) return;
  set.forEach(cid => {
    if(cid === excludeClientId) return;
    const sock = clients.get(cid);
    if(sock && sock.readyState === WebSocket.OPEN){
      try{ sock.send(JSON.stringify(messageObj)); }catch(e){ console.warn('broadcast err', e); }
    } else {
      // queue for offline
      deliveryQueue[cid] = deliveryQueue[cid] || [];
      deliveryQueue[cid].push({ from:'server', payload:messageObj, ts: Date.now() });
      persistQueue();
    }
  });
}

// Extend your ws message handler to handle room commands:
// Incoming client messages (JSON) should include type:
// - { type:"join-room", room:"roomId", clientId }
// - { type:"leave-room", room:"roomId", clientId }
// - { type:"room-message", room:"roomId", from:"clientId", payload: {...} }  // server will broadcast to room
// - { type:"list-room", room:"roomId" } -> server responds { type:"room-members", room, members:[...] }
// - (existing) { type:'send', to:... } remains

wss.on('connection', (socket) => {
  socket.on('message', msgRaw => {
    let msg;
    try{ msg = JSON.parse(msgRaw.toString()); } catch(e){ console.warn('invalid json', e); return; }
    if(msg.type === 'register' && msg.clientId){
      socket.clientId = msg.clientId; clients.set(socket.clientId, socket);
      // deliver queued messages...
      if(deliveryQueue[socket.clientId] && deliveryQueue[socket.clientId].length){
        deliveryQueue[socket.clientId].forEach(item => {
          try{ socket.send(JSON.stringify({ type:'message', from: item.from, payload: item.payload })); }catch(e){}
        });
        delete deliveryQueue[socket.clientId];
        persistQueue();
      }
      socket.send(JSON.stringify({ type:'registered', clientId: socket.clientId }));
      return;
    }

    if(msg.type === 'join-room' && msg.room && socket.clientId){
      joinRoom(socket.clientId, msg.room);
      // notify the joining client with current members
      const members = Array.from(rooms.get(msg.room) || []);
      socket.send(JSON.stringify({ type:'room-members', room: msg.room, members }));
      // broadcast presence to others in room
      broadcastToRoom(msg.room, { type:'presence', room: msg.room, action:'join', clientId: socket.clientId }, socket.clientId);
      return;
    }

    if(msg.type === 'leave-room' && msg.room && socket.clientId){
      leaveRoom(socket.clientId, msg.room);
      broadcastToRoom(msg.room, { type:'presence', room: msg.room, action:'leave', clientId: socket.clientId }, socket.clientId);
      return;
    }

    if(msg.type === 'list-room' && msg.room){
      const members = Array.from(rooms.get(msg.room) || []);
      socket.send(JSON.stringify({ type:'room-members', room: msg.room, members }));
      return;
    }

    if(msg.type === 'room-message' && msg.room && msg.payload && socket.clientId){
      // Payload is opaque (client-side should encrypt). Server will broadcast to room (include from)
      broadcastToRoom(msg.room, { type:'room-message', room: msg.room, from: socket.clientId, payload: msg.payload }, socket.clientId);
      // optionally ack to sender
      socket.send(JSON.stringify({ type:'room-sent', room: msg.room }));
      return;
    }

    // existing send-to-specific-client handling
    if(msg.type === 'send' && msg.to && msg.payload){
      // existing code...
      const toSock = clients.get(msg.to);
      if(toSock && toSock.readyState === WebSocket.OPEN){
        toSock.send(JSON.stringify({ type:'message', from: socket.clientId||'unknown', payload: msg.payload }));
      } else {
        deliveryQueue[msg.to] = deliveryQueue[msg.to] || [];
        deliveryQueue[msg.to].push({ from: socket.clientId||'unknown', payload: msg.payload, ts: Date.now() });
        persistQueue();
      }
      return;
    }

    // ...other handlers...
  });
});