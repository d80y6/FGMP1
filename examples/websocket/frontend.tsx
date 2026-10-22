"use client";

/**
 * Apinator chat demo (replaces the retired socket.io demo, which connected
 * through the removed `?XTransformPort=` gateway proxy). Browsers now talk
 * straight to Apinator over wss://; private/presence subscriptions are
 * authorized by the demo server's POST /realtime/auth (in production, by
 * the app's session-checked /api/fgmp/realtime/auth route).
 *
 * Chat messages travel as CLIENT events (`client-message`) on the presence
 * channel: browser → Apinator → other browsers, without a server round-trip.
 * Client events require a private/presence channel and the `client-` prefix.
 */

import { useEffect, useRef, useState } from "react";
import { Apinator, type Channel, type ConnectionState } from "@apinator/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

const CHANNEL = "presence-chat-demo";

type ChatMessage = {
  id: string;
  username: string;
  content: string;
  timestamp: string;
  type: "user" | "system";
};

type PresenceMember = { user_id: string; user_info?: { name?: string } };

const systemMessage = (content: string): ChatMessage => ({
  id: Math.random().toString(36).slice(2, 11),
  username: "System",
  content,
  timestamp: new Date().toISOString(),
  type: "system",
});

/** The SDK parses JSON payloads but may hand back the raw string. */
function parsePayload(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

export default function RealtimeDemo() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState("");
  const [username, setUsername] = useState("");
  const [isUsernameSet, setIsUsernameSet] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const channelRef = useRef<Channel | null>(null);
  const clientRef = useRef<Apinator | null>(null);

  useEffect(() => {
    const appKey = process.env.NEXT_PUBLIC_APINATOR_APP_KEY;
    const cluster = process.env.NEXT_PUBLIC_APINATOR_CLUSTER ?? "eu";
    if (!appKey || !isUsernameSet) return;

    const client = new Apinator({
      appKey,
      cluster,
      // The demo server signs subscriptions; the production app uses
      // "/api/fgmp/realtime/auth" (session-checked). Same-origin cookies.
      authEndpoint: "http://localhost:3004/realtime/auth",
    });
    clientRef.current = client;

    client.bind("state_change", (data) => {
      const change = parsePayload(data) as { current?: ConnectionState } | null;
      setIsConnected(change?.current === "connected");
    });
    client.connect();

    const channel = client.subscribe(CHANNEL);
    channelRef.current = channel;

    // Presence roster: system events carry join/leave; the subscription
    // snapshot is available after realtime:subscription_succeeded.
    channel.bind("realtime:subscription_succeeded", (data) => {
      const snap = parsePayload(data) as { presence?: { hash?: Record<string, unknown> } } | null;
      setMembers(snap?.presence?.hash ? Object.keys(snap.presence.hash) : []);
    });
    channel.bind("realtime:member_added", (data) => {
      const m = parsePayload(data) as PresenceMember;
      const name = m?.user_info?.name ?? m?.user_id;
      setMessages((prev) => [...prev, systemMessage(`${name} joined the chat room`)]);
      setMembers((prev) => (prev.includes(m.user_id) ? prev : [...prev, m.user_id]));
    });
    channel.bind("realtime:member_removed", (data) => {
      const m = parsePayload(data) as PresenceMember;
      setMessages((prev) => [...prev, systemMessage(`${m?.user_id} left the chat room`)]);
      setMembers((prev) => prev.filter((u) => u !== m.user_id));
    });

    // Chat traffic as client events: browser → Apinator → browsers.
    channel.bind("client-message", (data) => {
      const msg = parsePayload(data) as ChatMessage | null;
      if (msg?.id) setMessages((prev) => [...prev, msg]);
    });

    return () => {
      channel.unbindAll();
      client.unbind("state_change");
      client.disconnect();
      channelRef.current = null;
      clientRef.current = null;
      setIsConnected(false);
    };
  }, [isUsernameSet]);

  const sendMessage = () => {
    const content = inputMessage.trim();
    if (!channelRef.current || !content || !username.trim()) return;
    const msg: ChatMessage = {
      id: Math.random().toString(36).slice(2, 11),
      username: username.trim(),
      content,
      timestamp: new Date().toISOString(),
      type: "user",
    };
    // Not delivered to the sender — other subscribers only (per Apinator's
    // client-event rule), so the sender appends its own copy locally.
    channelRef.current.trigger("client-message", msg);
    setMessages((prev) => [...prev, msg]);
    setInputMessage("");
  };

  return (
    <div className="container mx-auto p-4 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            Apinator Demo ({members.length} online)
            <span className={`text-sm px-2 py-1 rounded ${isConnected ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
              {isConnected ? "Connected" : "Disconnected"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isUsernameSet ? (
            <div className="space-y-2">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && username.trim()) setIsUsernameSet(true);
                }}
                placeholder="Enter your username..."
                className="flex-1"
              />
              <Button onClick={() => username.trim() && setIsUsernameSet(true)} disabled={!username.trim()} className="w-full">
                Join Chat
              </Button>
            </div>
          ) : (
            <>
              <ScrollArea className="h-80 w-full border rounded-md p-4">
                <div className="space-y-2">
                  {messages.length === 0 ? (
                    <p className="text-gray-500 text-center">No messages yet</p>
                  ) : (
                    messages.map((msg) => (
                      <div key={msg.id} className="border-b pb-2 last:border-b-0">
                        <div className="flex justify-between items-start">
                          <div className="flex-1">
                            <p className={`text-sm font-medium ${msg.type === "system" ? "text-blue-600 italic" : "text-gray-700"}`}>
                              {msg.username}
                            </p>
                            <p className={msg.type === "system" ? "text-blue-500 italic" : "text-gray-900"}>{msg.content}</p>
                          </div>
                          <span className="text-xs text-gray-500">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
              <div className="flex space-x-2">
                <Input
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                  placeholder="Type a message..."
                  disabled={!isConnected}
                  className="flex-1"
                />
                <Button onClick={sendMessage} disabled={!isConnected || !inputMessage.trim()}>
                  Send
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
