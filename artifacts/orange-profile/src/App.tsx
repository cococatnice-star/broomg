import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { toast } from '@/hooks/use-toast';
import NotFound from '@/pages/not-found';
import {
  Check,
  ChevronDown,
  ExternalLink,
  FastForward,
  GripHorizontal,
  MessageCircle,
  Send,
  ArrowLeft,
  LockKeyhole,
  Radio,
  RotateCw,
  Pause,
  Play,
  Rewind,
  UserRound,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  FaDiscord,
  FaGithub,
  FaTiktok,
  FaYoutube,
} from 'react-icons/fa6';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import {
  getGetOwnerChatConversationQueryKey,
  getGetVisitorChatConversationQueryKey,
  getListOwnerChatConversationsQueryKey,
  getListPublicChatMessagesQueryKey,
  type ChatMessage,
  useCreateChatMessage,
  useGetOwnerChatConversation,
  useGetVisitorChatConversation,
  useListOwnerChatConversations,
  useListPublicChatMessages,
  useSendOwnerChatReply,
} from '@workspace/api-client-react';

const queryClient = new QueryClient();
const PROFILE = {
  username: 'CocoX.wtf',
};
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY.');

function makeRandomId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function storedValue(key: string, create: () => string) {
  try {
    const current = localStorage.getItem(key);
    if (current) return current;
    const value = create();
    localStorage.setItem(key, value);
    return value;
  } catch {
    return create();
  }
}

function useVisitorIdentity() {
  const [visitorName, setVisitorName] = useState(() => {
    try { return localStorage.getItem('cocox.chat.name') ?? ''; } catch { return ''; }
  });
  const visitorToken = useRef(storedValue('cocox.chat.visitor-token', makeRandomId)).current;
  const [conversationId, setConversationId] = useState<string | null>(() => {
    try { return localStorage.getItem('cocox.chat.conversation-id'); } catch { return null; }
  });
  const saveName = (name: string) => {
    setVisitorName(name);
    try { localStorage.setItem('cocox.chat.name', name); } catch { /* storage is optional */ }
  };
  const saveConversationId = (id: string) => {
    setConversationId(id);
    try { localStorage.setItem('cocox.chat.conversation-id', id); } catch { /* storage is optional */ }
  };
  return { visitorName, saveName, visitorToken, conversationId, saveConversationId };
}

function addMessageOnce(messages: ChatMessage[] | undefined, incoming: ChatMessage) {
  const current = messages ?? [];
  return current.some((message) => message.id === incoming.id)
    ? current
    : [...current, incoming].sort((a, b) => a.id - b.id);
}

function useChatStream(scope: 'public' | 'visitor' | 'owner', conversationId?: string, visitorToken?: string, enabled = true) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled || (scope === 'visitor' && !conversationId)) return;
    const controller = new AbortController();
    let retryTimer: number | undefined;
    let active = true;
    const queryKey = scope === 'public'
      ? getListPublicChatMessagesQueryKey()
      : scope === 'visitor'
        ? getGetVisitorChatConversationQueryKey(conversationId!)
        : conversationId
          ? getGetOwnerChatConversationQueryKey(conversationId)
          : getListOwnerChatConversationsQueryKey();
    const recover = async () => {
      await queryClient.invalidateQueries({ queryKey });
      if (scope === 'owner') await queryClient.invalidateQueries({ queryKey: getListOwnerChatConversationsQueryKey() });
    };
    const connect = async () => {
      try {
        const params = new URLSearchParams({ scope });
        if (conversationId) params.set('conversationId', conversationId);
        const response = await fetch(`/api/chat/stream?${params}`, {
          credentials: 'include',
          headers: visitorToken ? { 'X-Chat-Token': visitorToken } : undefined,
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error('Chat stream unavailable');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (active) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const eventName = frame.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim();
            const data = frame.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim();
            if (eventName !== 'message' || !data) continue;
            try {
              const message = JSON.parse(data) as ChatMessage;
              if (scope === 'public' && message.channel === 'public') {
                queryClient.setQueryData<{ messages: ChatMessage[] }>(queryKey, (old) => ({
                  messages: addMessageOnce(old?.messages, message),
                }));
              } else if (scope === 'owner' && message.channel === 'private') {
                if (conversationId && message.conversationId === conversationId) {
                  queryClient.setQueryData<{ messages: ChatMessage[] }>(queryKey, (old) => old
                    ? { ...old, messages: addMessageOnce(old.messages, message) }
                    : old);
                }
                void queryClient.invalidateQueries({ queryKey: getListOwnerChatConversationsQueryKey() });
              } else if (scope === 'visitor' && message.conversationId === conversationId) {
                queryClient.setQueryData<{ messages: ChatMessage[] }>(queryKey, (old) => old
                  ? { ...old, messages: addMessageOnce(old.messages, message) }
                  : old);
              }
            } catch { /* ignore malformed event frames */ }
          }
        }
        if (active) await recover();
      } catch {
        if (!active || controller.signal.aborted) return;
        await recover();
      } finally {
        if (active) retryTimer = window.setTimeout(() => void connect(), 2200);
      }
    };
    void connect();
    return () => {
      active = false;
      controller.abort();
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [conversationId, enabled, queryClient, scope, visitorToken]);
}

type MusicTrack = {
  id: string;
  title: string;
  subtitle: string;
  source: string;
  cover: string;
};

const MUSIC_TRACKS: MusicTrack[] = [
  {
    id: 'misery',
    title: 'Misery',
    subtitle: 'PUPSIES · MISERY',
    source: `${import.meta.env.BASE_URL}audio/misery.mp3`,
    cover: `${import.meta.env.BASE_URL}images/misery-cover.png`,
  },
  {
    id: 'all-i-want-for-christmas',
    title: 'All I Want for Christmas Is You',
    subtitle: 'MARIAH CAREY · CHRISTMAS',
    source: `${import.meta.env.BASE_URL}audio/all-i-want-for-christmas.mp3`,
    cover: `${import.meta.env.BASE_URL}images/all-i-want-for-christmas.jpg`,
  },
];

const VIDEO_SOURCE = `${import.meta.env.BASE_URL}video/cocox-clip.mp4`;
const PROFILE_AVATAR = `${import.meta.env.BASE_URL}images/profile-cocox.png`;

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function ChatPanel({ onOpenInbox }: { onOpenInbox: () => void }) {
  const [mode, setMode] = useState<'public' | 'private'>('public');
  const [body, setBody] = useState('');
  const [sendError, setSendError] = useState('');
  const feedRef = useRef<HTMLDivElement>(null);
  const identity = useVisitorIdentity();
  const publicHistory = useListPublicChatMessages();
  const privateHistory = useGetVisitorChatConversation(identity.conversationId ?? '', {
    query: {
      enabled: mode === 'private' && Boolean(identity.visitorName.trim()) && Boolean(identity.conversationId),
      queryKey: getGetVisitorChatConversationQueryKey(identity.conversationId ?? ''),
    },
    request: { headers: { 'X-Chat-Token': identity.visitorToken }, credentials: 'include' },
  });
  const createMessage = useCreateChatMessage({ request: { credentials: 'include' } });
  const queryClient = useQueryClient();
  useChatStream('public');
  useChatStream('visitor', identity.conversationId ?? undefined, identity.visitorToken, mode === 'private' && Boolean(identity.visitorName.trim()) && Boolean(identity.conversationId));

  const messages = mode === 'public'
    ? (publicHistory.data?.messages ?? []).filter((message) => message.channel === 'public')
    : (privateHistory.data?.messages ?? []).filter((message) => message.channel === 'private');

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [messages.length, mode]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const senderName = identity.visitorName.trim();
    const messageBody = body.trim();
    if (!senderName) {
      setSendError('Add your name before sending a message.');
      return;
    }
    if (!messageBody) return;
    setSendError('');
    createMessage.mutate({
      data: {
        channel: mode,
        senderName,
        body: messageBody,
        visitorToken: identity.visitorToken,
        ...(mode === 'private' ? { conversationId: identity.conversationId } : {}),
      },
    }, {
      onSuccess: (message) => {
        setBody('');
        if (message.channel === 'public') {
          queryClient.setQueryData<{ messages: ChatMessage[] }>(getListPublicChatMessagesQueryKey(), (old) => ({
            messages: addMessageOnce(old?.messages, message),
          }));
        } else {
          if (message.conversationId) {
            identity.saveConversationId(message.conversationId);
            queryClient.setQueryData<{ conversation: unknown; messages: ChatMessage[] }>(
              getGetVisitorChatConversationQueryKey(message.conversationId),
              (old) => old ? { ...old, messages: addMessageOnce(old.messages, message) } : old,
            );
          }
        }
      },
      onError: () => setSendError('Message not sent. Check your connection and try again.'),
    });
  };

  const loading = mode === 'public' ? publicHistory.isLoading : privateHistory.isLoading;
  const failed = mode === 'public' ? publicHistory.isError : privateHistory.isError;
  const retry = () => {
    if (mode === 'public') void publicHistory.refetch();
    else void privateHistory.refetch();
  };

  return (
    <aside className="chat-panel" aria-label="Messages">
      <header className="chat-head">
        <div className="chat-brand-mark" aria-hidden="true"><MessageCircle size={17} /></div>
        <div className="chat-heading">
          <span className="chat-eyebrow">COCOX // LIVE</span>
          <h2>Say something.</h2>
        </div>
        <span className="chat-live" aria-label="Chat available"><i /> OPEN</span>
      </header>
      <div className="chat-tabs" role="tablist" aria-label="Message channel">
        <button type="button" role="tab" aria-selected={mode === 'public'} className={mode === 'public' ? 'is-active' : ''} onClick={() => { setMode('public'); setSendError(''); }}>
          <Radio size={12} /> PUBLIC
        </button>
        <button type="button" role="tab" aria-selected={mode === 'private'} className={mode === 'private' ? 'is-active' : ''} onClick={() => { setMode('private'); setSendError(''); }}>
          <LockKeyhole size={12} /> PRIVATE
        </button>
      </div>
      {mode === 'private' && (
        <div className="private-note">
          <LockKeyhole size={13} aria-hidden="true" />
          <span>A private note, just between you and CocoX.</span>
          <button type="button" className="inbox-link" onClick={onOpenInbox} title="Owner inbox shortcut: Ctrl+Shift+/">
            OWNER
          </button>
        </div>
      )}
      <div className="chat-log" ref={feedRef} aria-live="polite" aria-relevant="additions text">
        {loading && (
          <div className="chat-skeleton" aria-label="Loading messages">
            <span /><span /><span />
          </div>
        )}
        {failed && !loading && (
          <div className="chat-state chat-error">
            <p>Couldn’t load this conversation.</p>
            <button type="button" onClick={retry}>TRY AGAIN</button>
          </div>
        )}
        {!loading && !failed && messages.length === 0 && (
          <div className="chat-empty">
            <span className="empty-line" />
            <p>{mode === 'public' ? 'No messages yet.' : 'Your private thread starts here.'}</p>
            <small>{mode === 'public' ? 'Leave the first trace.' : 'Only you and CocoX can read this thread.'}</small>
          </div>
        )}
        {messages.map((message) => (
          <article className={`chat-message ${message.senderRole === 'owner' ? 'from-owner' : 'from-visitor'}`} key={message.id}>
            <div className="message-meta">
              <strong>{message.senderRole === 'owner' ? 'CocoX Owner' : message.senderName}</strong>
              <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            </div>
            <p>{message.body}</p>
          </article>
        ))}
      </div>
      <form className="chat-compose" onSubmit={submit}>
        <label className="chat-field-label" htmlFor="chat-name">YOUR NAME</label>
        <input
          id="chat-name"
          className="chat-name-input"
          value={identity.visitorName}
          maxLength={32}
          required
          placeholder="What should CocoX call you?"
          onChange={(event) => identity.saveName(event.currentTarget.value)}
        />
        <label className="chat-field-label" htmlFor="chat-body">{mode === 'public' ? 'MESSAGE TO THE ROOM' : 'PRIVATE MESSAGE'}</label>
        <div className="chat-message-entry">
          <textarea
            id="chat-body"
            value={body}
            maxLength={1200}
            rows={2}
            placeholder={mode === 'public' ? 'Leave a message…' : 'Write CocoX a private note…'}
            onChange={(event) => setBody(event.currentTarget.value)}
            required
          />
          <button type="submit" aria-label="Send message" disabled={createMessage.isPending || !identity.visitorName.trim() || !body.trim()}>
            <Send size={15} />
          </button>
        </div>
        <div className="chat-footer-row">
          {sendError ? <span className="chat-form-error" role="alert">{sendError}</span> : <span>{mode === 'public' ? 'PUBLIC ROOM · NO ACCOUNT NEEDED' : 'PRIVATE · ONLY YOU AND OWNER'}</span>}
          <span>{body.length}/1200</span>
        </div>
      </form>
    </aside>
  );
}

function OwnerInbox({ onClose }: { onClose: () => void }) {
  const { isLoaded, isSignedIn } = useAuth();
  const hasOwnerSession = isLoaded && Boolean(isSignedIn);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [replyError, setReplyError] = useState('');
  const list = useListOwnerChatConversations({
    query: { enabled: hasOwnerSession, queryKey: getListOwnerChatConversationsQueryKey(), staleTime: 0, refetchOnMount: 'always' },
    request: { credentials: 'include' },
  });
  const detail = useGetOwnerChatConversation(selectedId ?? '', {
    query: { enabled: hasOwnerSession && Boolean(selectedId), queryKey: getGetOwnerChatConversationQueryKey(selectedId ?? '') },
    request: { credentials: 'include' },
  });
  const sendReply = useSendOwnerChatReply({ request: { credentials: 'include' } });
  const queryClient = useQueryClient();
  const selectedConversation = list.data?.conversations.find((conversation) => conversation.id === selectedId);
  useChatStream('owner', selectedId ?? undefined, undefined, hasOwnerSession && list.isSuccess);

  useEffect(() => {
    if (isLoaded && !isSignedIn) setSelectedId(null);
  }, [isLoaded, isSignedIn]);

  const submitReply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedId || !reply.trim()) return;
    setReplyError('');
    sendReply.mutate({ conversationId: selectedId, data: { body: reply.trim() } }, {
      onSuccess: (message) => {
        setReply('');
        queryClient.setQueryData<{ conversation: unknown; messages: ChatMessage[] }>(
          getGetOwnerChatConversationQueryKey(selectedId),
          (old) => old ? { ...old, messages: addMessageOnce(old.messages, message) } : old,
        );
        void list.refetch();
      },
      onError: () => setReplyError('Reply failed. Try again.'),
    });
  };

  return (
    <aside className="chat-panel owner-inbox" aria-label="Owner inbox">
      <header className="chat-head owner-head">
        <div className="chat-brand-mark" aria-hidden="true"><LockKeyhole size={16} /></div>
        <div className="chat-heading">
          <span className="chat-eyebrow">PRIVATE // OWNER ONLY</span>
          <h2>Inbox</h2>
        </div>
        <button type="button" className="chat-close" aria-label="Close inbox" onClick={onClose}><X size={17} /></button>
      </header>
      <div className="owner-inbox-content">
        <section className="conversation-list" aria-label="Private conversations">
          <div className="conversation-list-title"><span>THREADS</span><button type="button" onClick={() => void list.refetch()} aria-label="Refresh conversations"><RotateCw size={13} /></button></div>
          {!isLoaded && <div className="chat-skeleton inbox-skeleton" role="status" aria-label="Checking sign-in"><span /><span /><span /></div>}
          {isLoaded && !isSignedIn && <div className="inbox-signin"><LockKeyhole size={19} /><strong>Owner access</strong><p>Sign in to check the private inbox. Access is verified securely by the server.</p><button type="button" onClick={() => { window.location.assign(`${basePath}/sign-in`); }}>SIGN IN</button></div>}
          {hasOwnerSession && list.isError && <div className="chat-state"><p>Inbox access is unavailable for this account.</p><small>Check the owner email allowlist and server connection.</small><button type="button" onClick={() => void list.refetch()}>TRY AGAIN</button></div>}
          {hasOwnerSession && list.isLoading && <div className="chat-skeleton inbox-skeleton" role="status" aria-label="Loading private conversations"><span /><span /><span /></div>}
          {hasOwnerSession && list.isSuccess && (list.data?.conversations.length ?? 0) === 0 && (
            <div className="inbox-empty">No private messages yet.</div>
          )}
          {hasOwnerSession && list.isSuccess && list.data?.conversations.map((conversation) => (
            <button type="button" key={conversation.id} className={`conversation-item${selectedId === conversation.id ? ' selected' : ''}`} onClick={() => setSelectedId(conversation.id)}>
              <span className="conversation-avatar">{conversation.guestName.slice(0, 1).toUpperCase()}</span>
              <span className="conversation-copy"><strong>{conversation.guestName}</strong><small>{conversation.preview}</small></span>
              <time>{new Date(conversation.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</time>
            </button>
          ))}
        </section>
        <section className="owner-thread" aria-label="Conversation thread">
          {!isLoaded ? (
            <div className="thread-placeholder"><div className="chat-skeleton"><span /><span /></div></div>
          ) : !isSignedIn ? (
            <div className="thread-placeholder"><LockKeyhole size={21} /><p>Sign in to read private threads.</p></div>
          ) : !selectedId ? (
            <div className="thread-placeholder"><MessageCircle size={21} /><p>Select a thread to read it.</p></div>
          ) : (
            <>
              <div className="owner-thread-title">
                <button type="button" className="back-to-threads" aria-label="Back to threads" onClick={() => setSelectedId(null)}><ArrowLeft size={15} /></button>
                <span><strong>{selectedConversation?.guestName ?? detail.data?.conversation.guestName ?? 'Conversation'}</strong><small>PRIVATE THREAD</small></span>
              </div>
              <div className="owner-thread-messages">
                {detail.isLoading && <div className="chat-skeleton"><span /><span /></div>}
                {detail.isError && <div className="chat-state"><p>Couldn’t load this thread.</p><button type="button" onClick={() => void detail.refetch()}>TRY AGAIN</button></div>}
                {detail.data?.messages.filter((message) => message.channel === 'private').map((message) => (
                  <article className={`chat-message ${message.senderRole === 'owner' ? 'from-owner' : 'from-visitor'}`} key={message.id}>
                    <div className="message-meta"><strong>{message.senderRole === 'owner' ? 'CocoX Owner' : message.senderName}</strong><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
                    <p>{message.body}</p>
                  </article>
                ))}
              </div>
              <form className="chat-compose owner-compose" onSubmit={submitReply}>
                <label className="chat-field-label" htmlFor="owner-reply">REPLY AS COCOX OWNER</label>
                <div className="chat-message-entry">
                  <textarea id="owner-reply" rows={2} maxLength={1200} value={reply} placeholder="Write a private reply…" onChange={(event) => setReply(event.currentTarget.value)} required />
                  <button type="submit" aria-label="Send owner reply" disabled={sendReply.isPending || !reply.trim()}><Send size={15} /></button>
                </div>
                {replyError && <span className="chat-form-error" role="alert">{replyError}</span>}
              </form>
            </>
          )}
        </section>
      </div>
    </aside>
  );
}

function useDraggable() {
  const panelRef = useRef<HTMLElement | null>(null);
  const offsetRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{
    pointerId: number;
    pointerX: number;
    pointerY: number;
    offsetX: number;
    offsetY: number;
    bounds: { left: number; top: number; right: number; bottom: number };
  } | null>(null);
  const panelRefCallback = useCallback((node: HTMLElement | null) => {
    panelRef.current = node;
    if (!node) return;
    node.style.setProperty('--drag-x', `${offsetRef.current.x}px`);
    node.style.setProperty('--drag-y', `${offsetRef.current.y}px`);
  }, []);

  const applyPosition = (x: number, y: number) => {
    offsetRef.current = { x, y };
    panelRef.current?.style.setProperty('--drag-x', `${x}px`);
    panelRef.current?.style.setProperty('--drag-y', `${y}px`);
  };

  const finishDrag = (event?: ReactPointerEvent<HTMLButtonElement>) => {
    const panel = panelRef.current;
    const drag = dragRef.current;
    panel?.classList.remove('is-dragging');
    if (
      event &&
      drag?.pointerId === event.pointerId &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };

  const dragHandleProps = {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!event.isPrimary || event.button !== 0 || !panelRef.current) return;
      event.preventDefault();
      const bounds = panelRef.current.getBoundingClientRect();
      dragRef.current = {
        pointerId: event.pointerId,
        pointerX: event.clientX,
        pointerY: event.clientY,
        offsetX: offsetRef.current.x,
        offsetY: offsetRef.current.y,
        bounds: {
          left: bounds.left - offsetRef.current.x,
          top: bounds.top - offsetRef.current.y,
          right: bounds.right - offsetRef.current.x,
          bottom: bounds.bottom - offsetRef.current.y,
        },
      };
      panelRef.current.classList.add('is-dragging');
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const padding = 20;
      const nextX = drag.offsetX + event.clientX - drag.pointerX;
      const nextY = drag.offsetY + event.clientY - drag.pointerY;
      const minX = padding - drag.bounds.left;
      const maxX = window.innerWidth - padding - drag.bounds.right;
      const minY = padding - drag.bounds.top;
      const maxY = window.innerHeight - padding - drag.bounds.bottom;
      applyPosition(
        Math.min(Math.max(nextX, minX), Math.max(minX, maxX)),
        Math.min(Math.max(nextY, minY), Math.max(minY, maxY)),
      );
    },
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => finishDrag(event),
    onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => finishDrag(event),
    onLostPointerCapture: () => finishDrag(),
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const step = event.shiftKey ? 32 : 16;
      let dx = 0;
      let dy = 0;
      if (event.key === 'ArrowLeft') dx = -step;
      else if (event.key === 'ArrowRight') dx = step;
      else if (event.key === 'ArrowUp') dy = -step;
      else if (event.key === 'ArrowDown') dy = step;
      else return;

      event.preventDefault();
      const panel = panelRef.current;
      if (!panel) return;
      const bounds = panel.getBoundingClientRect();
      const baseLeft = bounds.left - offsetRef.current.x;
      const baseTop = bounds.top - offsetRef.current.y;
      const baseRight = bounds.right - offsetRef.current.x;
      const baseBottom = bounds.bottom - offsetRef.current.y;
      const minX = 20 - baseLeft;
      const maxX = window.innerWidth - 20 - baseRight;
      const minY = 20 - baseTop;
      const maxY = window.innerHeight - 20 - baseBottom;
      applyPosition(
        Math.min(Math.max(offsetRef.current.x + dx, minX), Math.max(minX, maxX)),
        Math.min(Math.max(offsetRef.current.y + dy, minY), Math.max(minY, maxY)),
      );
    },
  };

  return { panelRef: panelRefCallback, dragHandleProps };
}

function CursorFollower() {
  const dotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    document.body.classList.add('has-custom-cursor');
    const moveCursor = (event: PointerEvent) => {
      const position = `translate3d(${event.clientX}px, ${event.clientY}px, 0) translate(-50%, -50%)`;
      if (dotRef.current) {
        dotRef.current.style.transform = position;
        dotRef.current.classList.add('is-visible');
      }
      if (ringRef.current) {
        ringRef.current.style.transform = position;
        ringRef.current.classList.add('is-visible');
        const target = event.target;
        ringRef.current.classList.toggle(
          'is-interactive',
          target instanceof Element && Boolean(target.closest('a, button, input, [role="slider"]')),
        );
      }
    };
    const hideCursor = () => {
      dotRef.current?.classList.remove('is-visible');
      ringRef.current?.classList.remove('is-visible');
    };

    window.addEventListener('pointermove', moveCursor, { passive: true });
    window.addEventListener('blur', hideCursor);
    return () => {
      window.removeEventListener('pointermove', moveCursor);
      window.removeEventListener('blur', hideCursor);
      document.body.classList.remove('has-custom-cursor');
    };
  }, []);

  return (
    <>
      <div ref={ringRef} className="custom-cursor-ring" aria-hidden="true" />
      <div ref={dotRef} className="custom-cursor-dot" aria-hidden="true" />
    </>
  );
}

function Home() {
  const [ownerInboxOpen, setOwnerInboxOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.72);
  const [playing, setPlaying] = useState(false);
  const [isAway, setIsAway] = useState(false);
  const [currentTrack, setCurrentTrack] = useState(MUSIC_TRACKS[0]);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [audioMessage, setAudioMessage] = useState('');
  const [videoOpen, setVideoOpen] = useState(false);
  const [videoMessage, setVideoMessage] = useState('');
  const audioRef = useRef<HTMLAudioElement>(null);
  const visualizerRef = useRef<HTMLSpanElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoCloseRef = useRef<HTMLButtonElement>(null);
  const resumeMusicAfterVideoRef = useRef(false);
  const profileCardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const musicDrag = useDraggable();
  const socialDrag = useDraggable();
  const aboutDrag = useDraggable();

  useEffect(() => {
    const onInboxShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditing = target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'));
      if (event.ctrlKey && event.shiftKey && !event.altKey && (event.code === 'Slash' || event.key === '?') && !isEditing) {
        event.preventDefault();
        setOwnerInboxOpen(true);
      }
    };
    window.addEventListener('keydown', onInboxShortcut);
    return () => window.removeEventListener('keydown', onInboxShortcut);
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let silentGain: GainNode | null = null;

    const connectVisualizer = () => {
      if (analyser) return;
      const media = audio as HTMLAudioElement & {
        captureStream?: () => MediaStream;
        mozCaptureStream?: () => MediaStream;
      };
      const captureStream = media.captureStream ?? media.mozCaptureStream;
      if (!captureStream || !window.AudioContext) return;

      try {
        context = new window.AudioContext();
        source = context.createMediaStreamSource(captureStream.call(media));
        analyser = context.createAnalyser();
        silentGain = context.createGain();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.78;
        silentGain.gain.value = 0;
        source.connect(analyser);
        analyser.connect(silentGain);
        silentGain.connect(context.destination);
        analyserRef.current = analyser;
        void context.resume().catch(() => undefined);
      } catch {
        analyserRef.current = null;
        source?.disconnect();
        analyser?.disconnect();
        silentGain?.disconnect();
        void context?.close();
      }
    };

    window.addEventListener('pointerdown', connectVisualizer);
    window.addEventListener('keydown', connectVisualizer);

    return () => {
      window.removeEventListener('pointerdown', connectVisualizer);
      window.removeEventListener('keydown', connectVisualizer);
      analyserRef.current = null;
      source?.disconnect();
      analyser?.disconnect();
      silentGain?.disconnect();
      if (context && context.state !== 'closed') void context.close();
    };
  }, []);

  useEffect(() => {
    const visualizer = visualizerRef.current;
    if (!visualizer) return;

    const bars = Array.from(visualizer.children) as HTMLElement[];
    const bands: [number, number][] = [[0, 3], [3, 7], [7, 13], [13, 25], [25, 48]];
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let frequencyData: Uint8Array<ArrayBuffer> | null = null;

    const draw = () => {
      const audio = audioRef.current;
      const active = playing && Boolean(audio && !audio.paused && !audio.ended);
      const analyser = analyserRef.current;

      if (active && audio && !reducedMotion) {
        if (analyser) {
          if (!frequencyData || frequencyData.length !== analyser.frequencyBinCount) {
            frequencyData = new Uint8Array(analyser.frequencyBinCount);
          }
          analyser.getByteFrequencyData(frequencyData);
          bars.forEach((bar, index) => {
            const [start, end] = bands[index] ?? [0, 1];
            const rangeEnd = Math.min(end, frequencyData!.length);
            let total = 0;
            for (let bin = start; bin < rangeEnd; bin += 1) {
              total += frequencyData![bin] ?? 0;
            }
            const average = total / Math.max(1, rangeEnd - start);
            const strength = Math.min(1, Math.sqrt(average / 255) * 1.55);
            bar.style.transform = `scaleY(${0.16 + strength * 0.84})`;
          });
        } else {
          const time = audio.currentTime;
          const volumeScale = audio.muted ? 0 : audio.volume;
          bars.forEach((bar, index) => {
            const wave = (Math.sin(time * (8 + index * 1.7) + index * 1.4) + 1) / 2;
            bar.style.transform = `scaleY(${0.16 + wave * 0.84 * volumeScale})`;
          });
        }
        frame = window.requestAnimationFrame(draw);
        return;
      }

      bars.forEach((bar) => {
        bar.style.transform = 'scaleY(.16)';
      });
    };

    draw();
    return () => window.cancelAnimationFrame(frame);
  }, [playing]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.muted = muted;
    audio.volume = volume;
    void audio.play().then(() => {
      setPlaying(true);
      setAudioMessage('');
    }).catch(() => {
      setAudioMessage('Your browser blocked audio autoplay. Tap Play to start the music.');
    });
  }, []);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.muted = muted;
      audioRef.current.volume = volume;
    }
  }, [muted, volume]);

  useEffect(() => {
    if (!aboutOpen) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAboutOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [aboutOpen]);

  const profileStatusLabel = isAway
    ? 'AWAY'
    : playing
      ? `LISTENING · ${currentTrack.title}`
      : 'ONLINE';
  const profileStatusDescription = isAway
    ? 'away'
    : playing
      ? `listening to ${currentTrack.title}`
      : 'online';

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      try {
        await audio.play();
        setPlaying(true);
        setAudioMessage('');
        toast({
          title: 'Music resumed',
          description: currentTrack.title,
          duration: 2800,
        });
      } catch {
        setAudioMessage('Playback was blocked. Tap Play to try again.');
        setPlaying(false);
        toast({
          title: 'Music could not start',
          description: 'Tap Play again to retry.',
          variant: 'destructive',
          duration: 4200,
        });
      }
    } else {
      audio.pause();
      setPlaying(false);
      toast({
        title: 'Music paused',
        description: currentTrack.title,
        duration: 2400,
      });
    }
  };

  const handleProfilePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse') return;
    const card = event.currentTarget;
    const bounds = card.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const y = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height));

    card.style.setProperty('--tilt-x', `${((x - 0.5) * 10).toFixed(2)}deg`);
    card.style.setProperty('--tilt-y', `${((0.5 - y) * 8).toFixed(2)}deg`);
    card.style.setProperty('--glow-x', `${(x * 100).toFixed(1)}%`);
    card.style.setProperty('--glow-y', `${(y * 100).toFixed(1)}%`);
    card.classList.add('is-tilting');
  };

  const resetProfileTilt = () => {
    const card = profileCardRef.current;
    if (!card) return;
    card.style.setProperty('--tilt-x', '0deg');
    card.style.setProperty('--tilt-y', '0deg');
    card.classList.remove('is-tilting');
  };

  const seekBy = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + seconds));
  };

  const selectTrack = async (track: MusicTrack) => {
    const audio = audioRef.current;
    setSelectorOpen(false);
    if (!audio) return;

    setCurrentTrack(track);
    audio.currentTime = 0;
    setCurrentTime(0);
    setDuration(0);
    setAudioMessage('');
    audio.pause();
    audio.src = track.source;
    audio.load();
    try {
      await audio.play();
      setPlaying(true);
      toast({
        title: 'Now playing',
        description: `${track.title} · ${track.subtitle.split(' · ')[0]}`,
        duration: 3600,
      });
    } catch {
      setPlaying(false);
      setAudioMessage('Playback was blocked. Tap Play to try again.');
      toast({
        title: 'Track could not start',
        description: 'Tap Play to try again.',
        variant: 'destructive',
        duration: 4200,
      });
    }
  };

  const closeVideo = () => {
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
    setVideoOpen(false);
    setVideoMessage('');
    if (resumeMusicAfterVideoRef.current && audioRef.current) {
      void audioRef.current.play().then(() => {
        setPlaying(true);
        setAudioMessage('');
        toast({
          title: 'Music resumed',
          description: currentTrack.title,
          duration: 2800,
        });
      }).catch(() => {
        setPlaying(false);
        setAudioMessage('Playback was blocked. Tap Play to resume the music.');
        toast({
          title: 'Music could not resume',
          description: 'Tap Play to restart the track.',
          variant: 'destructive',
          duration: 4200,
        });
      });
    }
    resumeMusicAfterVideoRef.current = false;
  };

  useEffect(() => {
    if (videoOpen) videoCloseRef.current?.focus();
  }, [videoOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditing =
        target instanceof HTMLElement &&
        (target.isContentEditable || target.matches('input, textarea, select'));

      if (
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        (event.code === 'Period' || event.key === '>' || event.key === '.') &&
        !isEditing
      ) {
        event.preventDefault();
        const video = videoRef.current;
        if (!video) return;
        const audio = audioRef.current;
        if (!videoOpen) resumeMusicAfterVideoRef.current = Boolean(audio && !audio.paused);
        audio?.pause();
        video.currentTime = 0;
        setVideoMessage('');
        setVideoOpen(true);
        void video.play().then(() => {
          toast({
            title: 'Video playing',
            description: 'Press Esc or use the close button to exit.',
            duration: 3600,
          });
        }).catch(() => {
          setVideoMessage('Press Play in the video controls to start playback.');
          toast({
            title: 'Video playback blocked',
            description: 'Press Play in the video controls to start.',
            variant: 'destructive',
            duration: 4200,
          });
        });
        return;
      }

      if (event.key === 'Escape' && videoOpen) closeVideo();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [videoOpen]);

  return (
    <main className="profile-stage" aria-label="Orange Profile">
      <div
        ref={profileCardRef}
        className="profile-card"
        aria-label={`Discord profile: ${PROFILE.username}`}
        onPointerMove={handleProfilePointerMove}
        onPointerLeave={resetProfileTilt}
      >
        <img className="profile-avatar" src={PROFILE_AVATAR} alt={`${PROFILE.username} profile picture`} />
        <span className="profile-name">{PROFILE.username}</span>
        <button
          type="button"
          className="profile-status"
          aria-pressed={isAway}
          aria-label={`Status ${profileStatusDescription}. ${isAway ? 'Return to live status' : 'Set status to away'}.`}
          title={isAway ? 'Click to return to live music status' : 'Click to set status to away'}
          onClick={() => setIsAway((away) => !away)}
        >
          <span className={`profile-status-dot${isAway ? ' is-away' : playing ? ' is-listening' : ''}`} />
          <span className="profile-status-text">{profileStatusLabel}</span>
        </button>
      </div>

      <section
        ref={musicDrag.panelRef}
        className={`player-card${playing ? ' is-playing' : ''}`}
        aria-label={`Music player: ${currentTrack.title}`}
      >
        <audio
          ref={audioRef}
          src={currentTrack.source}
          preload="auto"
          autoPlay
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onDurationChange={(event) => setDuration(event.currentTarget.duration)}
          onEnded={() => setPlaying(false)}
          onPlay={() => {
            setPlaying(true);
            setAudioMessage('');
          }}
          onPause={() => setPlaying(false)}
        />
        <div className="mini-window-bar player-window-bar">
          <span className="window-label">MUSIC PLAYER</span>
          <button
            type="button"
            className="drag-handle"
            aria-label="Move music player; use arrow keys to move"
            title="Drag or use arrow keys to move"
            {...musicDrag.dragHandleProps}
          >
            <GripHorizontal size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="player-row">
          <button
            className="track-select"
            aria-label="Open music selector"
            aria-expanded={selectorOpen}
            aria-controls="track-selector"
            onClick={() => setSelectorOpen((open) => !open)}
          >
            <img className="mini-art" src={currentTrack.cover} alt="" />
            <span className="track-label">
              <span className="track-title-row">
                <span className="track-title">{currentTrack.title}</span>
                <span ref={visualizerRef} className={`audio-visualizer${playing ? ' is-active' : ''}`} aria-hidden="true">
                  <i /><i /><i /><i /><i />
                </span>
              </span>
              <span className="track-subtitle">{currentTrack.subtitle}</span>
            </span>
            <ChevronDown className="selector-chevron" size={14} aria-hidden="true" />
          </button>
          <div className="transport-controls" aria-label="Playback controls">
            <button className="player-button" aria-label="Rewind 10 seconds" onClick={() => seekBy(-10)}>
              <Rewind size={15} />
            </button>
            <button className="play-button" aria-label={playing ? 'Pause music' : 'Play music'} onClick={() => void togglePlayback()}>
              {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
            </button>
            <button className="player-button" aria-label="Forward 10 seconds" onClick={() => seekBy(10)}>
              <FastForward size={15} />
            </button>
          </div>
          <div className="volume-wrap">
            <button className="player-button" aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => setMuted((value) => !value)}>
              {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
            <input
              aria-label="Volume"
              className="volume-range"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(event) => setVolume(Number(event.currentTarget.value))}
            />
          </div>
        </div>
        <div className="player-extras">
          <span>{formatTime(currentTime)}</span>
          <div
            className="progress-line"
            role="slider"
            aria-label="Track position"
            aria-valuemin={0}
            aria-valuemax={duration || 0}
            aria-valuenow={currentTime}
            aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
            tabIndex={0}
            onClick={(event) => {
              if (!audioRef.current || !duration) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              const progress = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
              audioRef.current.currentTime = progress * duration;
            }}
            onKeyDown={(event) => {
              if (!audioRef.current) return;
              if (event.key === 'ArrowRight') audioRef.current.currentTime = Math.min(duration, currentTime + 5);
              if (event.key === 'ArrowLeft') audioRef.current.currentTime = Math.max(0, currentTime - 5);
            }}
          >
            <div className="progress-fill" style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }} />
          </div>
          <span>{formatTime(duration)}</span>
        </div>
        {audioMessage && <p className="player-hint" role="status">{audioMessage}</p>}
        {selectorOpen && (
          <div className="track-selector" id="track-selector" aria-label="Music selector">
            <div className="selector-heading">
              <span>Music library</span>
              <span>{MUSIC_TRACKS.length} TRACKS</span>
            </div>
            {MUSIC_TRACKS.map((track) => {
              const isCurrent = track.id === currentTrack.id;
              return (
                <button
                  key={track.id}
                  className="selector-track"
                  aria-pressed={isCurrent}
                  aria-label={`Play ${track.title} by ${track.subtitle.split(' · ')[0]}`}
                  onClick={() => void selectTrack(track)}
                >
                  <img src={track.cover} alt="" />
                  <span className="selector-track-copy">
                    <span className="track-title">{track.title}</span>
                    <span className="track-subtitle">{track.subtitle}</span>
                  </span>
                  <span className={`selector-track-state${isCurrent ? ' is-current' : ''}`}>
                    {isCurrent && playing
                      ? <span className="playing-bars" aria-label="Now playing"><i /><i /><i /></span>
                      : isCurrent
                        ? <Check size={15} />
                        : <Play size={14} />}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <nav ref={socialDrag.panelRef} className="actions" aria-label="Social links and profile actions">
        <div className="mini-window-bar social-window-bar">
          <span className="window-label">SOCIAL LINKS</span>
          <button
            type="button"
            className="drag-handle"
            aria-label="Move social links; use arrow keys to move"
            title="Drag or use arrow keys to move"
            {...socialDrag.dragHandleProps}
          >
            <GripHorizontal size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="social-icons" aria-label="Social profiles">
          <a
            className="social-icon"
            href="https://discord.com/users/1153432454980448381"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Discord profile for wsp_hey_areuok_yes"
            title="Discord · wsp_hey_areuok_yes"
          >
            <FaDiscord aria-hidden="true" />
          </a>
          <a
            className="social-icon"
            href="https://m.youtube.com/@CocoX.W_tf?ra=m"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="YouTube channel CocoX.W_tf"
            title="YouTube · @CocoX.W_tf"
          >
            <FaYoutube aria-hidden="true" />
          </a>
          <a
            className="social-icon"
            href="https://www.tiktok.com/@cocox.wtf"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="TikTok profile @cocox.wtf"
            title="TikTok · @cocox.wtf"
          >
            <FaTiktok aria-hidden="true" />
          </a>
          <a
            className="social-icon"
            href="https://github.com/cococatnice-star"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub profile cococatnice-star"
            title="GitHub · cococatnice-star"
          >
            <FaGithub aria-hidden="true" />
          </a>
        </div>
        <div className="action-links">
          <button className="action-button" onClick={() => setAboutOpen(true)}>
            <UserRound size={12} strokeWidth={1.8} /> About Me
          </button>
          <a className="action-button" href="https://cocox.wtf" target="_blank" rel="noreferrer">
            <ExternalLink size={12} strokeWidth={1.8} /> Main Website
          </a>
        </div>
        <div className="video-shortcut-hint" aria-label="Keyboard shortcut to play the video">
          <span>PLAY VIDEO</span>
          <kbd>CTRL</kbd><b>+</b><kbd>SHIFT</kbd><b>+</b><kbd>.</kbd>
        </div>
      </nav>

      {aboutOpen && (
        <div className="about-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setAboutOpen(false);
        }}>
          <section
            ref={aboutDrag.panelRef}
            className="about-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-title"
          >
            <div className="mini-window-bar about-window-bar">
              <div className="about-kicker">A little about me</div>
              <div className="window-controls">
                <button
                  type="button"
                  className="drag-handle"
                  aria-label="Move About Me panel; use arrow keys to move"
                  title="Drag or use arrow keys to move"
                  {...aboutDrag.dragHandleProps}
                >
                  <GripHorizontal size={15} aria-hidden="true" />
                </button>
                <button ref={closeRef} className="close-about" aria-label="Close About Me" onClick={() => setAboutOpen(false)}>
                  <X size={16} />
                </button>
              </div>
            </div>
            <h1 id="about-title">Hey, I’m {PROFILE.username}.</h1>
            <p>I’ve been coding for about two years. I know how to code Roblox and Unity scripts, and how to make games.</p>
            <p>I like making devices and coding programs and apps. I also make exploits for Roblox.</p>
            <div className="about-foot">ALWAYS BUILDING SOMETHING NEW</div>
          </section>
        </div>
      )}
      <div
        className={`video-backdrop${videoOpen ? ' is-open' : ''}`}
        role="dialog"
        aria-modal={videoOpen}
        aria-label="CocoX video player"
        aria-hidden={!videoOpen}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) closeVideo();
        }}
      >
        <section className="video-window">
          <div className="video-window-header">
            <div className="video-window-title">
              <span className="window-label">COCOX VIDEO</span>
              <span className="video-window-shortcut">CTRL + SHIFT + .</span>
            </div>
            <button
              ref={videoCloseRef}
              type="button"
              className="close-video"
              aria-label="Close video"
              onClick={closeVideo}
            >
              <X size={16} />
            </button>
          </div>
          <video
            ref={videoRef}
            className="profile-video"
            src={VIDEO_SOURCE}
            controls
            playsInline
            preload="none"
            onError={() => setVideoMessage('The video could not be loaded.')}
          />
          {videoMessage && <p className="video-message" role="status">{videoMessage}</p>}
        </section>
      </div>
      {ownerInboxOpen
        ? <OwnerInbox onClose={() => setOwnerInboxOpen(false)} />
        : <ChatPanel onOpenInbox={() => setOwnerInboxOpen(true)} />}
      <button type="button" className="inbox-shortcut" onClick={() => setOwnerInboxOpen(true)} aria-label="Open owner inbox" title="Owner inbox · Ctrl+Shift+/">
        <LockKeyhole size={12} /><span>OWNER INBOX</span><kbd>CTRL</kbd><b>+</b><kbd>SHIFT</kbd><b>+</b><kbd>/</kbd>
      </button>
      <CursorFollower />
    </main>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#ff790c',
    colorForeground: '#f4f0eb',
    colorMutedForeground: '#aaa39d',
    colorDanger: '#ff745e',
    colorBackground: '#11100f',
    colorInput: '#181614',
    colorInputForeground: '#f4f0eb',
    colorNeutral: '#4c3424',
    fontFamily: 'Manrope, sans-serif',
    borderRadius: '0.8rem',
  },
  elements: {
    rootBox: 'w-full max-w-full flex justify-center',
    cardBox: 'bg-[#11100f] border border-[#57351e] rounded-2xl w-[440px] max-w-full overflow-hidden shadow-2xl',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#fff5eb] font-bold tracking-tight',
    headerSubtitle: 'text-[#b7aaa0]',
    socialButtonsBlockButtonText: 'text-[#f4f0eb] font-medium',
    formFieldLabel: 'text-[#e1d4ca]',
    footerActionLink: 'text-[#ff9a43] hover:text-[#ffb477]',
    footerActionText: 'text-[#aaa39d]',
    dividerText: 'text-[#aaa39d]',
    identityPreviewEditButton: 'text-[#ff9a43]',
    formFieldSuccessText: 'text-[#ffb477]',
    alertText: 'text-[#ffd1c7]',
    logoBox: 'mb-3',
    logoImage: 'max-h-10',
    socialButtonsBlockButton: 'border border-[#453124] bg-[#191512] hover:bg-[#24180f]',
    formButtonPrimary: 'bg-[#ff790c] text-[#160b04] font-bold hover:bg-[#ff9a43]',
    formFieldInput: 'border-[#4a3628] bg-[#181614] text-[#f4f0eb]',
    footerAction: 'border-t border-[#33271f]',
    dividerLine: 'bg-[#453124]',
    alert: 'border-[#693b2b] bg-[#291714]',
    otpCodeFieldInput: 'border-[#4a3628] bg-[#181614] text-[#f4f0eb]',
    formFieldRow: 'mb-4',
    main: 'gap-4',
  },
};

function SignInPage() {
  return (
    <main className="auth-stage">
      <div className="auth-orbit" aria-hidden="true" />
      <div className="auth-intro"><img src={`${basePath}/logo.svg`} alt="" /><span>COCOX.WTF // PRIVATE ACCESS</span><h1>Back in the room.</h1><p>Sign in to check private messages. Public chat stays open to everyone.</p></div>
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </main>
  );
}

function SignUpPage() {
  return (
    <main className="auth-stage">
      <div className="auth-orbit" aria-hidden="true" />
      <div className="auth-intro"><img src={`${basePath}/logo.svg`} alt="" /><span>COCOX.WTF // ACCOUNT</span><h1>Make yourself known.</h1><p>Create an account to continue to CocoX.wtf.</p></div>
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </main>
  );
}

function ClerkRoutes() {
  const [, setLocation] = useLocation();
  const stripBase = (path: string) => basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to access the owner inbox.' } },
        signUp: { start: { title: 'Create your account', subtitle: 'A little closer to the conversation.' } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <ClerkQueryClientCacheInvalidator />
      <Router />
    </ClerkProvider>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const cache = useQueryClient();
  const previousUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (previousUserId.current !== undefined && previousUserId.current !== userId) cache.clear();
      previousUserId.current = userId;
    });
    return unsubscribe;
  }, [addListener, cache]);
  return null;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={basePath}>
          <ClerkRoutes />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
