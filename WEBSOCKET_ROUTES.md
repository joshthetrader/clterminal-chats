# WebSocket Routes - Complete Mapping

## Backend Routes (clterminal-chats)

### 1. **Chat Room WebSocket** - `/ws`
- **URL:** `wss://clterminal-chats-production.up.railway.app/ws`
- **Frontend:** `LiveNewsWindow.jsx`, `chatClient.js`
- **Purpose:** Real-time chat messages, trade shares, presence tracking
- **Message Types:**
  - `hello` - User login with name and color
  - `chat` - Chat message
  - `share` - Trade share (symbol, side, leverage, entry)
- **Environment Variable:** `VITE_CHAT_WS_URL`
- **Status Code:** 500 errors indicate connection issues

### 2. **News Feed WebSocket** - `/ws-news`
- **URL:** `wss://clterminal-chats-production.up.railway.app/ws-news`
- **Frontend:** `news.js` (not actively used in UI currently)
- **Purpose:** Real-time news updates
- **Message Types:**
  - `subscribe` - Subscribe to news feed
  - `message` - News item
- **Status Code:** 0 indicates no clients connected

### 3. **Volatility Alerts WebSocket** - `/ws-volatility`
- **URL:** `wss://clterminal-chats-production.up.railway.app/ws-volatility`
- **Frontend:** `VolatilityAlerts.jsx`
- **Purpose:** Real-time volatility alerts with historical data on connect
- **Message Types:**
  - `subscribe` - Subscribe to volatility alerts
  - `history` - Last 10 alerts on connection
  - `alert` - New volatility alert
- **Status Code:** 0 indicates no clients connected, 200 = receiving alerts

## Frontend WebSocket Clients

### Chat-Related
- **File:** `src/components/windows/LiveNewsWindow.jsx` (line 13)
  - Connects to: `/ws`
  - Purpose: Display chat room
  
- **File:** `src/services/chatClient.js` (line 4)
  - Connects to: `/ws`
  - Purpose: Chat service layer

### Alerts & Monitoring
- **File:** `src/components/windows/VolatilityAlerts.jsx` (line 96)
  - Connects to: `/ws-volatility`
  - Purpose: Display volatility alerts

## Exchange WebSocket Connections (Not Backend Routes)

These connect directly to exchange APIs, not the backend:

- **Bybit:** `wss://stream.bybit.com/v5/public/linear` (Price feeds, orderbook)
- **Bybit (Testnet):** `wss://stream-testnet.bybit.com/v5/public`
- **Blofin:** `wss://openapi.blofin.com/ws/public` (Ticker)
- **Blofin (Private):** `wss://openapi.blofin.com/ws/private` (Positions)
- **Bitunix:** `wss://fapi.bitunix.com/public/` (Public)
- **Bitunix (Private):** `wss://fapi.bitunix.com/private/` (Private)

## Status Code Mapping

### Backend `/ws` Route
- **500** - WebSocket connection error (see detailed logs)
- **Successful** - WebSocket opens, should show connection details in logs

### Backend `/ws-news` Route
- **0** - No connected clients (normal when not subscribed)
- **Successful** - Connected and receiving news

### Backend `/ws-volatility` Route
- **0** - No connected clients (no alerts being sent)
- **Successful** - Connected and receiving volatility alerts

## Log Entry Format

### Connection Request
```
🔌 [WS-REQUEST] {"timestamp":"2025-11-25T09:51:58.000Z","method":"GET","path":"/ws","ip":"111.95.215.148",...}
```

### Successful Connection
```
✅ [WS abc123] Connection established - IP: 111.95.215.148, Host: clterminal-chats-production.up.railway.app
```

### Chat Message
```
💬 [WS abc123] Chat message - {"id":"msg123","user":"Joshua","length":45,"hasReply":false}
```

### Trade Share
```
📈 [WS abc123] Trade share - {"symbol":"BTCUSDT","side":"Long","leverage":"10","entry":"42000","user":"Joshua"}
```

### Connection Close
```
👋 [WS abc123] Connection closed - user: Joshua, duration: 5000ms
```

### Error
```
❌ [WS-ERROR] {"timestamp":"2025-11-25T09:51:58.000Z","path":"/ws","ip":"111.95.215.148","error":"..."}
```

## Troubleshooting

### I see `/ws` with status 500
- Check backend logs for error details
- See format: `❌ [WS-ERROR] {...}`
- Common issues: Database connection, message parsing

### I see `/ws-volatility` with status 0
- This is normal - means no active alerts
- Status 0 = ready to receive alerts, not an error
- Wait for volatility to trigger or send test alert

### I see `/ws-news` with status 0
- Normal - indicates route is available but no subscribers
- News endpoint not actively used in current UI

### Missing detailed logs
- Ensure you're viewing the backend logs in Railway dashboard
- Check that the deployment has the latest version with enhanced logging

## Configuration

### Environment Variables
- `VITE_CHAT_WS_URL` - Frontend chat WebSocket URL (defaults to production)

### Backend Port
- Chat server runs on port 3001 by default
- Railway auto-assigns port via `process.env.PORT`

## Next Steps

1. **Monitor logs** - All connections should show detailed JSON logs
2. **Track errors** - Look for `❌` prefix in logs for issues
3. **Validate paths** - Confirm `/ws`, `/ws-news`, `/ws-volatility` are being hit
4. **Check status codes** - 200/500 for HTTP, 0 for WS ready state

