// Choose which DASH representations to download: the selected (or best) video
// plus the best matching audio. DASH keeps video and audio in separate
// representations, so there is almost always a mux step.

import type { DashManifest } from '../dash';

export interface DashPlan {
  videoRepId: string;
  /** Present when there's a separate audio representation to mux in. */
  audioRepId?: string;
}

export function planDashTracks(manifest: DashManifest, videoRepId?: string): DashPlan {
  const reps = manifest.representations;
  const videos = reps.filter((r) => r.type === 'video');
  const audios = reps.filter((r) => r.type === 'audio');

  // Representations are pre-sorted best-first by the parser.
  if (videos.length === 0) {
    // Audio-only stream: download the single best audio track.
    const audio = audios[0];
    if (!audio) throw new Error('No downloadable representations found.');
    return { videoRepId: audio.id };
  }

  const video = (videoRepId && videos.find((r) => r.id === videoRepId)) || videos[0];
  return { videoRepId: video.id, audioRepId: audios[0]?.id };
}
