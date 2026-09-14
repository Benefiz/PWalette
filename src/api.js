export const API_BASE = 'https://api.pixelwalker.net';
export const GAME_BASE = 'https://server.pixelwalker.net';
export const CLIENT_VERSION = '2026.11.1';

export async function loginWithPassword(email, password) {
  const url = `${API_BASE}/api/collections/users/auth-with-password`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Version': CLIENT_VERSION
    },
    body: JSON.stringify({ identity: email, password: password })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.message || 'Login failed. Please check your credentials.');
  }

  return await response.json(); // returns { token, record: { id, username, role, ... } }
}

export async function fetchWorlds(token) {
  let allItems = [];
  let page = 1;
  const perPage = 100;
  let totalPages = 1;

  do {
    const url = `${API_BASE}/api/collections/worlds/records?page=${page}&perPage=${perPage}&sort=-updated`;
    const response = await fetch(url, {
      headers: {
        'Authorization': token,
        'X-Client-Version': CLIENT_VERSION
      }
    });

    if (!response.ok) {
      throw new Error('Failed to fetch worlds list.');
    }

    const data = await response.json();
    const items = data.items || [];
    allItems = allItems.concat(items);
    
    totalPages = data.totalPages || 1;
    page++;
  } while (page <= totalPages);

  return allItems;
}

export async function fetchRoomTypes() {
  const url = `${GAME_BASE}/listroomtypes`;
  const response = await fetch(url, {
    headers: { 'X-Client-Version': CLIENT_VERSION }
  });
  if (!response.ok) throw new Error('Failed to fetch room types.');
  return await response.json(); // returns e.g. ["pixelwalker"]
}

export async function fetchJoinKey(roomId, token = null, roomType = 'pixelwalker') {
  const url = `${API_BASE}/api/joinkey/${roomType}/${roomId}`;
  const headers = {
    'X-Client-Version': CLIENT_VERSION
  };
  if (token) {
    headers['Authorization'] = token;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    if (response.status === 403) {
      throw new Error('Forbidden. The join key could not be retrieved. Is your token valid?');
    }
    throw new Error('Failed to fetch join key.');
  }

  const data = await response.json();
  return data.token; // Returns JWT join key
}

export async function fetchOnlineRooms(roomType = 'pixelwalker') {
  const url = `${GAME_BASE}/room/list/${roomType}`;
  const response = await fetch(url, {
    headers: { 'X-Client-Version': CLIENT_VERSION }
  });
  if (!response.ok) throw new Error('Failed to fetch online rooms.');
  const data = await response.json();
  return data.visibleRooms || [];
}
