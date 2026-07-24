import { get, set, del, keys, createStore } from 'idb-keyval';
import type { Project } from '../types';

const store = createStore('asv', 'kv');

const PROJECT_PREFIX = 'project:';
const AUDIO_PREFIX = 'audio:';
const IMAGE_PREFIX = 'img:';
const LAST_OPEN_KEY = 'lastOpenProjectId';

const projectKey = (id: string) => `${PROJECT_PREFIX}${id}`;
const audioKey = (id: string) => `${AUDIO_PREFIX}${id}`;
const imageKey = (id: string) => `${IMAGE_PREFIX}${id}`;

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  duration: number;
  transcribed: boolean;
  sceneCount: number;
}

export const saveProject = (p: Project) => set(projectKey(p.id), p, store);
export const loadProject = (id: string) => get<Project>(projectKey(id), store);

export const saveAudio = (id: string, blob: Blob) => set(audioKey(id), blob, store);
export const loadAudio = (id: string) => get<Blob>(audioKey(id), store);

export const saveImage = (id: string, blob: Blob) => set(imageKey(id), blob, store);
export const loadImage = (id: string) => get<Blob>(imageKey(id), store);
export const deleteImage = (id: string) => del(imageKey(id), store);

export const saveLastOpenId = (id: string) => set(LAST_OPEN_KEY, id, store);
export const loadLastOpenId = () => get<string>(LAST_OPEN_KEY, store);
export const clearLastOpenId = () => del(LAST_OPEN_KEY, store);

/** Every saved project, most recently edited first. */
export async function listProjects(): Promise<ProjectSummary[]> {
  const ks = await keys(store);
  const ids = ks
    .filter((k): k is string => typeof k === 'string' && k.startsWith(PROJECT_PREFIX))
    .map((k) => k.slice(PROJECT_PREFIX.length));
  const projects = await Promise.all(ids.map((id) => get<Project>(projectKey(id), store)));
  return projects
    .filter((p): p is Project => !!p)
    .map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt ?? p.createdAt,
      duration: p.duration,
      transcribed: p.transcribed,
      sceneCount: p.scenes.length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Permanently removes a project's record, its audio, and every image it references. Cannot be undone. */
export async function deleteProjectCompletely(id: string, imageIds: string[]) {
  await Promise.all([
    del(projectKey(id), store),
    del(audioKey(id), store),
    ...imageIds.map((imgId) => deleteImage(imgId)),
  ]);
}
