import { basename, join } from 'node:path';
import type { SocialData } from '../qq/social-store.js';
import type { SocialRepository } from '../storage/social-repository.js';
import type { MediaService } from './media.js';

type Entry = SocialData['images'][number];
type Image = Awaited<ReturnType<MediaService['image']>>;

export const isLibraryImage = (source: string): boolean => source.startsWith('image:');

export class ImageLibrary {
  constructor(private readonly store: SocialRepository, private readonly media: MediaService) {}

  async save(image: Image, metadata: Pick<Entry, 'description' | 'tags' | 'source'>, check: () => void) {
    check();
    const file = basename(await this.media.save(Buffer.from(image.data, 'base64'), '.' + image.mimeType.split('/')[1]));
    const id = 'image:' + file.split('.')[0];
    return this.store.update(draft => {
      check();
      const existing = draft.images.find(item => item.id === id);
      if (existing) return { id, already_saved: true };
      draft.images.push({ ...metadata, id, file, at: Date.now() });
      return { id, already_saved: false };
    });
  }

  search(query: string, limit: number) {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return this.store.view('images').images.reverse().filter(entry => {
      const text = [entry.id, entry.description, ...entry.tags].join(' ').toLowerCase();
      return terms.every(term => text.includes(term));
    }).slice(0, limit).map(({ id, description, tags, at }) => ({ id, description, tags, at }));
  }

  path(id: string): string {
    const entry = this.store.view('images').images.find(item => item.id === id);
    if (!entry) throw new Error('图库没有这张图片，请先用 qq_search_images 查找');
    return join(this.media.root, entry.file);
  }
}
