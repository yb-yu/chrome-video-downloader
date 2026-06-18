// Manage the single offscreen document that hosts the assembly engine.
// MV3 service workers are torn down after ~30s idle, so long-running work
// (downloading + assembling multi-hour streams) lives in the offscreen
// document instead.

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

let creating: Promise<void> | undefined;

export async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  // De-dupe concurrent creation attempts.
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: 'Assemble segmented video streams and write them to disk.',
      })
      .finally(() => {
        creating = undefined;
      });
  }
  try {
    await creating;
  } catch (err) {
    // Another caller may have created it first; tolerate that race.
    if (!(await hasOffscreen())) throw err;
  }
}

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return contexts.length > 0;
}
