/* 象棋 — Firestore 資料層：統計、留言、排行榜、連線對戰大廳 */
(async () => {
  if (window.XQ) return; // 已初始化過，避免重複載入覆蓋既有監聽器
  const V = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const api = {
    ready: false, uid: null, error: null,
    onStats: null, onComments: null, onBoard: null, onPvpBoard: null,
    onRooms: null, onRoom: null, onChat: null, onState: null
  };
  window.XQ = api;
  const notify = () => { try { api.onState && api.onState(); } catch (e) { /* ignore */ } };
  try {
    const [{ initializeApp }, A, F] = await Promise.all([
      import(V + 'firebase-app.js'), import(V + 'firebase-auth.js'), import(V + 'firebase-firestore.js')
    ]);
    const app = initializeApp({
      apiKey: 'AIzaSyDfYtpNhfRvKTttVZ2d1X-UdSxFvF9oLSI',
      authDomain: 'xiangqi-efa12.firebaseapp.com',
      projectId: 'xiangqi-efa12',
      storageBucket: 'xiangqi-efa12.firebasestorage.app',
      messagingSenderId: '745589061926',
      appId: '1:745589061926:web:c89c7421ff81389e7f29e7'
    });
    const db = F.getFirestore(app), auth = A.getAuth(app);
    const root = F.doc(db, 'xiangqi', 'stats');
    const cComments = F.collection(db, 'xiangqi', 'stats', 'comments');
    const cWins = F.collection(db, 'xiangqi', 'stats', 'wins');
    const cRooms = F.collection(db, 'xiangqi', 'stats', 'rooms');
    const cPvp = F.collection(db, 'xiangqi', 'stats', 'pvp');
    const now = () => F.serverTimestamp();

    /* --- 統計 / 留言 / 排行榜 --- */
    api.recordResult = (level, win) => F.runTransaction(db, async tx => {
      const s = await tx.get(root), d = s.exists() ? s.data() : {};
      const st = Object.assign({}, d.stats || {});
      const cur = Object.assign({ w: 0, l: 0 }, st[level]);
      if (win) cur.w++; else cur.l++;
      st[level] = cur;
      tx.set(root, { plays: (d.plays || 0) + 1, stats: st }, { merge: true });
    });
    api.addWin = w => F.addDoc(cWins, Object.assign({}, w, { uid: api.uid, at: now() }));
    api.addComment = c => F.addDoc(cComments, Object.assign({}, c, { uid: api.uid, at: now() }));
    api.remove = id => F.deleteDoc(F.doc(cComments, id));
    api.removeWin = id => F.deleteDoc(F.doc(cWins, id));

    /* 管理權限：密碼只存在 Firestore，由安全規則在伺服器端比對。
       前端只送出密碼，寫入成功代表密碼正確。 */
    api.claimAdmin = async pw => {
      await F.setDoc(F.doc(db, 'xiangqi', 'stats', 'admins', api.uid), { pw, at: now() });
      api.admin = true;
      return true;
    };

    /* --- 連線對戰 --- */
    api.createRoom = async (name, clock) => {
      // 先清掉自己舊的空房，避免大廳堆積
      try {
        const old = await F.getDocs(F.query(cRooms, F.where('host.uid', '==', api.uid)));
        await Promise.all(old.docs.filter(d => (d.data().status || 'wait') === 'wait').map(d => F.deleteDoc(d.ref)));
      } catch (e) { /* 清理失敗不影響開房 */ }
      const r = await F.addDoc(cRooms, {
        host: { uid: api.uid, name }, guest: null,
        status: 'wait', clock, moves: [], turn: 1,
        times: { r: clock.secs || 0, b: clock.secs || 0 },
        undoReq: null, rematch: {}, result: null,
        createdAt: now(), lastAt: now()
      });
      return r.id;
    };
    api.joinRoom = (id, name) => F.runTransaction(db, async tx => {
      const ref = F.doc(cRooms, id), s = await tx.get(ref);
      if (!s.exists()) throw new Error('房間不存在');
      const d = s.data();
      if (d.host.uid === api.uid) return;
      if (d.guest && d.guest.uid !== api.uid) throw new Error('房間已滿');
      tx.update(ref, { guest: { uid: api.uid, name }, status: 'playing', lastAt: now() });
    });
    api.pushMove = (id, move, times) => F.runTransaction(db, async tx => {
      const ref = F.doc(cRooms, id), s = await tx.get(ref);
      if (!s.exists()) return;
      const d = s.data(), ms = (d.moves || []).concat([move]);
      tx.update(ref, { moves: ms, turn: -(d.turn || 1), times: times || d.times, undoReq: null, lastAt: now() });
    });
    api.setResult = (id, result) => F.updateDoc(F.doc(cRooms, id), { status: 'done', result, lastAt: now() });
    api.requestUndo = id => F.updateDoc(F.doc(cRooms, id), { undoReq: api.uid, lastAt: now() });
    api.answerUndo = (id, ok) => F.runTransaction(db, async tx => {
      const ref = F.doc(cRooms, id), s = await tx.get(ref);
      if (!s.exists()) return;
      const d = s.data();
      if (!ok) { tx.update(ref, { undoReq: null }); return; }
      const ms = (d.moves || []).slice(0, -1);
      tx.update(ref, { moves: ms, turn: -(d.turn || 1), undoReq: null, lastAt: now() });
    });
    api.rematch = id => F.runTransaction(db, async tx => {
      const ref = F.doc(cRooms, id), s = await tx.get(ref);
      if (!s.exists()) return;
      const d = s.data(), rm = Object.assign({}, d.rematch || {});
      rm[api.uid] = true;
      const both = d.host && d.guest && rm[d.host.uid] && rm[d.guest.uid];
      if (both) tx.update(ref, { moves: [], turn: 1, status: 'playing', result: null, rematch: {}, undoReq: null, times: { r: (d.clock || {}).secs || 0, b: (d.clock || {}).secs || 0 }, lastAt: now() });
      else tx.update(ref, { rematch: rm, lastAt: now() });
    });
    api.leaveRoom = async id => { try { await F.deleteDoc(F.doc(cRooms, id)); } catch (e) { /* 非房主 */ } };
    api.sendChat = (id, name, text) => F.addDoc(F.collection(db, 'xiangqi', 'stats', 'rooms', id, 'chat'), { n: name, t: text, uid: api.uid, at: now() });
    api.recordPvp = win => F.runTransaction(db, async tx => {
      const ref = F.doc(cPvp, api.uid), s = await tx.get(ref);
      const d = s.exists() ? s.data() : { w: 0, l: 0 };
      tx.set(ref, { n: api.name || '匿名棋友', w: (d.w || 0) + (win ? 1 : 0), l: (d.l || 0) + (win ? 0 : 1), at: now() }, { merge: true });
    });

    let unRoom = null, unChat = null;
    api.watchRoom = id => {
      if (unRoom) unRoom(); if (unChat) unChat();
      if (!id) { unRoom = unChat = null; return; }
      unRoom = F.onSnapshot(F.doc(cRooms, id), s => api.onRoom && api.onRoom(s.exists() ? Object.assign({ id: s.id }, s.data()) : null));
      unChat = F.onSnapshot(F.query(F.collection(db, 'xiangqi', 'stats', 'rooms', id, 'chat'), F.orderBy('at', 'asc'), F.limit(100)),
        s => api.onChat && api.onChat(s.docs.map(d => d.data())));
    };
    let unLobby = null;
    api.watchLobby = on => {
      if (unLobby) { unLobby(); unLobby = null; }
      if (!on) return;
      unLobby = F.onSnapshot(F.query(cRooms, F.orderBy('lastAt', 'desc'), F.limit(40)),
        s => api.onRooms && api.onRooms(s.docs.map(d => Object.assign({ id: d.id }, d.data()))),
        e => { api.error = e.code; notify(); });
    };

    A.onAuthStateChanged(auth, async user => {
      if (!user) return;
      api.uid = user.uid; api.ready = true; api.error = null;
      try {
        const v = F.doc(db, 'xiangqi', 'stats', 'visitors', user.uid);
        if (!(await F.getDoc(v)).exists()) {
          await F.setDoc(v, { at: now() });
          await F.runTransaction(db, async tx => {
            const s = await tx.get(root);
            tx.set(root, { visitors: ((s.exists() ? s.data().visitors : 0) || 0) + 1 }, { merge: true });
          });
        }
      } catch (e) { /* 訪客計數失敗不影響遊戲 */ }
      F.onSnapshot(root, s => api.onStats && api.onStats(s.exists() ? s.data() : {}), e => { api.error = e.code; notify(); });
      F.onSnapshot(F.query(cComments, F.orderBy('at', 'desc'), F.limit(60)),
        s => api.onComments && api.onComments(s.docs.map(d => Object.assign({ id: d.id }, d.data()))), e => { api.error = e.code; notify(); });
      F.onSnapshot(F.query(cWins, F.orderBy('rank', 'desc'), F.limit(30)),
        s => api.onBoard && api.onBoard(s.docs.map(d => Object.assign({ id: d.id }, d.data()))), e => { /* 索引未建 */ });
      F.onSnapshot(F.query(cPvp, F.orderBy('w', 'desc'), F.limit(20)),
        s => api.onPvpBoard && api.onPvpBoard(s.docs.map(d => Object.assign({ id: d.id }, d.data()))), e => { /* 索引未建 */ });
      notify();
    });
    await A.signInAnonymously(auth).catch(e => { api.error = e.code; notify(); });
  } catch (e) {
    api.error = (e && (e.code || e.message)) || 'load-failed';
    notify();
  }
})();
