// Decide which media-playlist URLs make up a downloadable HLS selection.
//
// A master playlist's variant may carry its audio inline (a single muxed
// track) or reference a separate audio rendition via its AUDIO group. This
// pure planner resolves the chosen variant + matching audio so the engine can
// assemble each track and (when there are two) mux them together.

import type { HlsPlaylist } from '../hls';

export interface HlsPlan {
  videoUrl: string;
  /** Present only when audio is a separate rendition that must be muxed in. */
  audioUrl?: string;
}

export function planHlsTracks(
  detectedUrl: string,
  playlist: HlsPlaylist,
  variantUri?: string,
): HlsPlan {
  // A media playlist is already a single (typically muxed) track.
  if (playlist.kind === 'media') {
    return { videoUrl: detectedUrl };
  }

  const variant =
    (variantUri && playlist.variants.find((v) => v.uri === variantUri)) ||
    playlist.variants[0];
  if (!variant) {
    throw new Error('Master playlist has no variants.');
  }

  let audioUrl: string | undefined;
  if (variant.audioGroup) {
    const renditions = playlist.renditions.filter(
      (r) => r.type === 'AUDIO' && r.groupId === variant.audioGroup && r.uri,
    );
    // A rendition without its own URI means the audio is muxed into the
    // variant already, so only treat a URI-bearing rendition as separate.
    const chosen = renditions.find((r) => r.isDefault) ?? renditions[0];
    audioUrl = chosen?.uri;
  }

  return { videoUrl: variant.uri, audioUrl };
}
