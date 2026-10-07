/**
 * Detects pages that demand human verification (CAPTCHA / challenge walls).
 * We NEVER attempt to bypass these. Instead the run pauses via an approval
 * request so the operator can intervene manually, then resume.
 */
const MARKERS = [
  'verify you are human',
  'human verification',
  'confirm you are not a robot',
  'unusual traffic',
  'captcha',
  'cloudflare ray id',
  'checking your browser',
  'attention required',
  'security check',
  'solve the puzzle',
];

export interface HumanVerificationCheck {
  detected: boolean;
  marker?: string;
  title?: string;
}

export function detectHumanVerification(page: { title: string; text: string }): HumanVerificationCheck {
  const haystack = `${page.title}\n${page.text}`.toLowerCase().slice(0, 20_000);
  for (const marker of MARKERS) {
    if (haystack.includes(marker)) return { detected: true, marker, title: page.title };
  }
  return { detected: false };
}
