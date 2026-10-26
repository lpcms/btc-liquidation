/**
 * Client websocket hub.
 *
 * Maintains the set of connected browser clients and broadcasts each newly
 * collected liquidation to all of them as JSON. This is the push channel that
 * lets the chart show liquidations in real time without polling.
 *
 * The hub is intentionally simple: clients only receive liquidation messages;
 * historical data is loaded by the client over REST before the socket opens.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { Liquidation } from './types.js';

/**
 * Message envelope pushed to clients. A discriminating "type" field leaves room
 * for additional message kinds later without breaking the client parser.
 */
interface LiquidationMessage {
    type: 'liquidation';
    data: Liquidation;
}

/**
 * Wraps a ws WebSocketServer attached to an existing HTTP server on a fixed
 * path, tracking live connections for broadcast.
 */
export class ClientHub {
    private readonly wss: WebSocketServer;

    /**
     * Attaches a websocket server to the given HTTP server at path "/ws".
     * Sharing the HTTP server keeps everything on a single port.
     */
    constructor(server: Server) {
        this.wss = new WebSocketServer({ server, path: '/ws' });

        this.wss.on('connection', (socket: WebSocket) => {
            /**
             * Drop a client on socket error to avoid broadcasting to a dead
             * connection. The ws server removes it from its client set on close.
             */
            socket.on('error', () => {
                socket.terminate();
            });
        });
    }

    /**
     * Broadcasts a liquidation to every client whose socket is open.
     * Serialization happens once and the same payload is sent to all clients.
     */
    broadcast(liq: Liquidation): void {
        const message: LiquidationMessage = { type: 'liquidation', data: liq };
        const payload = JSON.stringify(message);

        for (const client of this.wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        }
    }

    /**
     * Closes the websocket server. Used during graceful shutdown.
     */
    close(): void {
        this.wss.close();
    }
}
