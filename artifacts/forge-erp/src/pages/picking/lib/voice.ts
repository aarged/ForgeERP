/** Speak a short instruction using the Web Speech API. Silent if unsupported. */
export function speak(text: string): void {
  try {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1;
    utter.pitch = 1;
    utter.volume = 1;
    synth.speak(utter);
  } catch {
    /* ignore */
  }
}
