import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AudioChunk, Lecture, ReviewLogEntry, StudyCard } from '../types';

interface StudyDB extends DBSchema {
  lectures: { key: string; value: Lecture; indexes: { byCreated: number } };
  cards: { key: string; value: StudyCard; indexes: { byLecture: string; byStatus: string } };
  chunks: { key: string; value: AudioChunk; indexes: { byLecture: string } };
  reviews: { key: string; value: ReviewLogEntry; indexes: { byAt: number; byCard: string } };
}

const DB_NAME = 'g2-study';
const DB_VERSION = 1;

/** Thin typed wrapper around IndexedDB. Everything the plugin knows lives here. */
export class Store {
  private constructor(private db: IDBPDatabase<StudyDB>) {}

  static async open(name = DB_NAME): Promise<Store> {
    const db = await openDB<StudyDB>(name, DB_VERSION, {
      upgrade(db) {
        const lectures = db.createObjectStore('lectures', { keyPath: 'id' });
        lectures.createIndex('byCreated', 'createdAt');
        const cards = db.createObjectStore('cards', { keyPath: 'id' });
        cards.createIndex('byLecture', 'lectureId');
        cards.createIndex('byStatus', 'status');
        const chunks = db.createObjectStore('chunks', { keyPath: 'id' });
        chunks.createIndex('byLecture', 'lectureId');
        const reviews = db.createObjectStore('reviews', { keyPath: 'id' });
        reviews.createIndex('byAt', 'at');
        reviews.createIndex('byCard', 'cardId');
      },
    });
    return new Store(db);
  }

  // Lectures
  putLecture(l: Lecture) {
    return this.db.put('lectures', l);
  }
  getLecture(id: string) {
    return this.db.get('lectures', id);
  }
  async listLectures(): Promise<Lecture[]> {
    const all = await this.db.getAllFromIndex('lectures', 'byCreated');
    return all.reverse();
  }
  async updateLecture(id: string, patch: Partial<Lecture>): Promise<Lecture | undefined> {
    const tx = this.db.transaction('lectures', 'readwrite');
    const cur = await tx.store.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    await tx.store.put(next);
    await tx.done;
    return next;
  }
  async deleteLecture(id: string) {
    const tx = this.db.transaction(['lectures', 'cards', 'chunks'], 'readwrite');
    await tx.objectStore('lectures').delete(id);
    for (const key of await tx.objectStore('cards').index('byLecture').getAllKeys(id)) {
      await tx.objectStore('cards').delete(key);
    }
    for (const key of await tx.objectStore('chunks').index('byLecture').getAllKeys(id)) {
      await tx.objectStore('chunks').delete(key);
    }
    await tx.done;
  }

  // Cards
  putCard(c: StudyCard) {
    return this.db.put('cards', c);
  }
  async putCards(cards: StudyCard[]) {
    const tx = this.db.transaction('cards', 'readwrite');
    await Promise.all(cards.map((c) => tx.store.put(c)));
    await tx.done;
  }
  getCard(id: string) {
    return this.db.get('cards', id);
  }
  deleteCard(id: string) {
    return this.db.delete('cards', id);
  }
  listCards() {
    return this.db.getAll('cards');
  }
  listCardsByLecture(lectureId: string) {
    return this.db.getAllFromIndex('cards', 'byLecture', lectureId);
  }
  listActiveCards() {
    return this.db.getAllFromIndex('cards', 'byStatus', 'active');
  }

  // Audio chunks
  putChunk(c: AudioChunk) {
    return this.db.put('chunks', c);
  }
  async listChunks(lectureId: string): Promise<AudioChunk[]> {
    const all = await this.db.getAllFromIndex('chunks', 'byLecture', lectureId);
    return all.sort((a, b) => a.index - b.index);
  }

  // Reviews
  putReview(r: ReviewLogEntry) {
    return this.db.put('reviews', r);
  }
  async recentReviews(limit = 200): Promise<ReviewLogEntry[]> {
    const out: ReviewLogEntry[] = [];
    let cursor = await this.db.transaction('reviews').store.index('byAt').openCursor(null, 'prev');
    while (cursor && out.length < limit) {
      out.push(cursor.value);
      cursor = await cursor.continue();
    }
    return out;
  }

  async clearAll() {
    const tx = this.db.transaction(['lectures', 'cards', 'chunks', 'reviews'], 'readwrite');
    await Promise.all([
      tx.objectStore('lectures').clear(),
      tx.objectStore('cards').clear(),
      tx.objectStore('chunks').clear(),
      tx.objectStore('reviews').clear(),
    ]);
    await tx.done;
  }
}

export function uid(prefix = ''): string {
  const rnd = crypto.getRandomValues(new Uint32Array(2));
  return prefix + Date.now().toString(36) + rnd[0].toString(36) + rnd[1].toString(36);
}
