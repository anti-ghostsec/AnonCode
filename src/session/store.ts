import { EncryptedStore, newId } from "../store/store.ts";
import type { Message, Session, ContentPart, Role } from "./types.ts";

/**
 * Sessions and their messages, persisted as encrypted records.
 *
 * - Sessions live in the `sessions` collection (id -> Session).
 * - Each session's messages live in `messages/<sessionId>` (id -> Message),
 *   one sealed file per message. Ids sort chronologically, so listing a
 *   session's messages returns them in order with no plaintext index.
 */
export class SessionStore {
  constructor(private readonly store: EncryptedStore) {}

  createSession(input: { provider: string; model: string; title?: string }): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: newId("sess"),
      title: input.title ?? "untitled session",
      provider: input.provider,
      model: input.model,
      createdAt: now,
      updatedAt: now,
    };
    this.store.putJSON("sessions", session.id, session);
    return session;
  }

  getSession(id: string): Session | null {
    return this.store.getJSON<Session>("sessions", id);
  }

  listSessions(): Session[] {
    return this.store
      .list("sessions")
      .map((id) => this.store.getJSON<Session>("sessions", id))
      .filter((s): s is Session => s !== null);
  }

  private touch(session: Session): void {
    session.updatedAt = new Date().toISOString();
    this.store.putJSON("sessions", session.id, session);
  }

  setTitle(session: Session, title: string): void {
    session.title = title;
    this.touch(session);
  }

  addMessage(session: Session, role: Role, parts: ContentPart[]): Message {
    const message: Message = {
      id: newId("msg"),
      role,
      parts,
      createdAt: new Date().toISOString(),
    };
    this.store.putJSON(`messages/${session.id}`, message.id, message);
    this.touch(session);
    return message;
  }

  messages(session: Session): Message[] {
    const coll = `messages/${session.id}`;
    return this.store
      .list(coll)
      .map((id) => this.store.getJSON<Message>(coll, id))
      .filter((m): m is Message => m !== null);
  }
}
