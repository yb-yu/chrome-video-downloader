// ffmpeg argument builders for the mux/remux step.
//
// We always stream-copy (-c copy): no re-encoding, so muxing a multi-hour
// stream is fast and lossless. `+faststart` moves the moov atom to the front
// so the result starts playing before it's fully downloaded. Do not force an
// audio bitstream filter here: the MP4 muxer automatically handles ADTS AAC,
// while an AAC-only filter fails on valid EC-3/Atmos tracks.

export function buildRemuxArgs(inputPath: string, outPath: string): string[] {
  return [
    '-i',
    inputPath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    outPath,
  ];
}

export function buildMuxArgs(
  videoPath: string,
  audioPath: string,
  outPath: string,
): string[] {
  return [
    '-i',
    videoPath,
    '-i',
    audioPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    outPath,
  ];
}
