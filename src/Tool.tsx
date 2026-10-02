// Murmur: record a voice standup (or type it), get it transcribed in the browser, and compile a 60-second team digest.
import { useEffect, useRef, useState } from "react";
import { idbGet, idbSet } from "./lib/idb";
import { uid, useCopy, useStored } from "./lib/store";
import { todayISO, prettyDate } from "./lib/time";
import { Section, Stat, Stats } from "./ui/kit";

const T = "murmur";
type Entry = { id: string; who: string; date: string; text: string; yesterday: string; today: string; blockers: string; audio: boolean; secs: number };
type SR = { start(): void; stop(): void; continuous: boolean; interimResults: boolean; lang: string; onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null; onend: (() => void) | null };

/** Split a spoken update into yesterday, today and blockers by listening for those words. */
function split(text: string) {
  const noBlock = /\b(no|nothing|zero|none)\s+(blockers?|blocking|blocked)\b\.?|\bnot blocked\b\.?/gi;
  const s = " " + text.replace(noBlock, "").replace(/\s+/g, " ") + " ";
  const find = (rx: RegExp) => { const m = s.search(rx); return m < 0 ? Infinity : m; };
  const iy = find(/\b(yesterday|last time|since last)\b/i), it = find(/\b(today|this morning|next|now i('| a)m|i will|i'll)\b/i), ib = find(/\b(block|stuck|waiting on|waiting for|need help|problem)\w*/i);
  const marks = [["yesterday", iy], ["today", it], ["blockers", ib]].filter(x => x[1] !== Infinity).sort((a, b) => (a[1] as number) - (b[1] as number)) as [string, number][];
  const out: Record<string, string> = { yesterday: "", today: "", blockers: "" };
  if (!marks.length) out.today = text.trim();
  marks.forEach(([k, i], n) => { out[k] = s.slice(i, n + 1 < marks.length ? marks[n + 1][1] : undefined).trim(); });
  if (/\b(no|nothing|none) block/i.test(out.blockers) || /\bnot blocked\b/i.test(out.blockers)) out.blockers = "";
  return out as { yesterday: string; today: string; blockers: string };
}

function Player({ id }: { id: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => { idbGet<Blob>(`${T}:${id}`).then(b => b && setSrc(URL.createObjectURL(b))); }, [id]);
  return src ? <audio controls src={src} style={{ height: 32, maxWidth: "100%" }} /> : null;
}

export default function Murmur() {
  const [team, setTeam] = useStored(T, "team", "Amira, Walid, Ines, Karim");
  const [entries, setEntries] = useStored<Entry[]>(T, "entries", [
    { id: "e1", who: "Walid", date: todayISO(), text: "Yesterday I finished the invoice export. Today I'm starting on the refund flow. Blocked on the payment sandbox keys from finance.", ...split("Yesterday I finished the invoice export. Today I'm starting on the refund flow. Blocked on the payment sandbox keys from finance."), audio: false, secs: 14 },
    { id: "e2", who: "Ines", date: todayISO(), text: "Yesterday I wrote tests for signup. Today I will pair with Amira on onboarding. No blockers.", ...split("Yesterday I wrote tests for signup. Today I will pair with Amira on onboarding. No blockers."), audio: false, secs: 10 },
  ]);
  const [who, setWho] = useStored(T, "who", "Amira");
  const [lang, setLang] = useStored(T, "lang", "en-US");
  const [date, setDate] = useState(todayISO());
  const [rec, setRec] = useState<{ start: number } | null>(null);
  const [live, setLive] = useState("");
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState("");
  const media = useRef<MediaRecorder | null>(null);
  const sr = useRef<SR | null>(null);
  const finalText = useRef("");
  const { copy, copied } = useCopy();
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  const SRC = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  const people = team.split(",").map(s => s.trim()).filter(Boolean);
  const day = entries.filter(e => e.date === date);
  const missing = people.filter(p => !day.some(e => e.who === p));

  const start = async () => {
    setErr(""); finalText.current = ""; setLive("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream); const chunks: Blob[] = [];
      mr.ondataavailable = e => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const id = uid(), text = (finalText.current || typed).trim();
        await idbSet(`${T}:${id}`, new Blob(chunks, { type: mr.mimeType }));
        setEntries(es => [{ id, who, date, text, ...split(text), audio: true, secs: Math.round((Date.now() - (recStart.current || Date.now())) / 1000) }, ...es.filter(e => !(e.who === who && e.date === date))]);
        setTyped("");
      };
      media.current = mr; mr.start();
      if (SRC) {
        const r = new SRC(); r.continuous = true; r.interimResults = true; r.lang = lang;
        r.onresult = e => { let interim = ""; for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) finalText.current += t + " "; else interim += t; } setLive(finalText.current + interim); };
        r.onend = () => { if (sr.current === r) r.start(); };
        sr.current = r; r.start();
      }
      recStart.current = Date.now(); setRec({ start: Date.now() });
    } catch { setErr("The microphone is blocked. Allow it in the browser, or type your update below."); }
  };
  const recStart = useRef(0);
  const stop = () => { const r = sr.current; sr.current = null; r?.stop(); media.current?.stop(); setRec(null); };
  const saveTyped = () => { if (!typed.trim()) return; setEntries([{ id: uid(), who, date, text: typed.trim(), ...split(typed), audio: false, secs: 0 }, ...entries.filter(e => !(e.who === who && e.date === date))]); setTyped(""); };
  const digest = () => [`Standup digest, ${prettyDate(date)}`, ...day.map(e => `\n${e.who}\n${e.yesterday ? `- Done: ${e.yesterday}\n` : ""}${e.today ? `- Next: ${e.today}\n` : ""}${e.blockers ? `- BLOCKED: ${e.blockers}\n` : ""}`), missing.length ? `\nNo update yet: ${missing.join(", ")}` : ""].join("");

  return (
    <div className="stack">
      <Section title={`Standup for ${prettyDate(date)}`} aside={<input id="mu-date" type="date" className="input" style={{ width: "auto" }} value={date} onChange={e => setDate(e.target.value)} aria-label="Date" />}>
        <Stats><Stat value={`${day.length}/${people.length}`} label="Updates in" /><Stat value={day.filter(e => e.blockers).length} label="Blocked" tone={day.some(e => e.blockers) ? "bad" : "good"} /><Stat value={`${day.reduce((a, e) => a + e.secs, 0)}s`} label="Total talk time" /></Stats>
      </Section>
      <div className="grid2">
        <Section title="Your update">
          <div className="stack" style={{ gap: 12 }}>
            <div className="row"><label className="field"><span>I am</span><select id="mu-who" className="input" value={who} onChange={e => setWho(e.target.value)}>{people.map(p => <option key={p}>{p}</option>)}</select></label>
              {SRC && <label className="field"><span>Language</span><select id="mu-lang" className="input" value={lang} onChange={e => setLang(e.target.value)}>{["en-US", "en-GB", "fr-FR", "ar-TN", "es-ES", "de-DE"].map(l => <option key={l}>{l}</option>)}</select></label>}</div>
            <p className="note">Say what you did yesterday, what you will do today, and anything blocking you.</p>
            {!rec ? <button className="btn primary mu-rec" onClick={start}>Record my update</button> : <button className="btn mu-rec on" onClick={stop}>Stop and save</button>}
            {rec && <p className="mu-live">{live || "Listening…"}</p>}
            {!SRC && <p className="note">Live transcription works in Chrome and Edge. Elsewhere the audio is saved and you can type a summary.</p>}
            <label className="field"><span>Or type it</span><textarea id="mu-typed" className="input" rows={3} value={typed} onChange={e => setTyped(e.target.value)} /></label>
            <button className="btn small" style={{ alignSelf: "flex-start" }} onClick={saveTyped} disabled={!typed.trim()}>Save typed update</button>
            {err && <p className="pill bad">{err}</p>}
          </div>
        </Section>
        <Section title="Digest" aside={<button className="btn small primary" onClick={() => copy(digest())} disabled={!day.length}>{copied ? "Copied" : "Copy for the team chat"}</button>}>
          {day.length === 0 ? <p className="empty-note">No updates for this day yet.</p> : (
            <div className="stack" style={{ gap: 14 }}>
              {day.map(e => (
                <div key={e.id} className="mu-e">
                  <div className="row" style={{ justifyContent: "space-between" }}><strong>{e.who}</strong><button className="btn ghost small danger" onClick={() => setEntries(entries.filter(x => x.id !== e.id))}>Delete</button></div>
                  {e.yesterday && <p><span className="eyebrow">Done</span> {e.yesterday}</p>}
                  {e.today && <p><span className="eyebrow">Next</span> {e.today}</p>}
                  {e.blockers && <p><span className="pill bad">Blocked</span> {e.blockers}</p>}
                  {e.audio && <Player id={e.id} />}
                </div>
              ))}
              {missing.length > 0 && <p className="note">Waiting on: {missing.join(", ")}</p>}
            </div>
          )}
        </Section>
      </div>
      <Section title="Team"><label className="field"><span>Names, separated by commas</span><input id="mu-team" className="input" value={team} onChange={e => setTeam(e.target.value)} /></label>
        <p className="note" style={{ marginTop: 8 }}>Updates and recordings stay on this device. Share the digest in your team chat.</p></Section>
      <style>{`.mu-rec{font-size:18px;padding:16px 22px}.mu-rec.on{background:var(--bad);color:#fff;border-color:var(--bad);animation:mu 1.4s ease-in-out infinite}@keyframes mu{50%{opacity:.75}}
      .mu-live{font-family:var(--serif);font-size:20px;line-height:1.4;padding:12px;border-radius:8px;background:var(--sunk)}.mu-e{padding-bottom:12px;border-bottom:1px solid var(--line);display:grid;gap:4px}.mu-e .eyebrow{font-size:10px;margin-right:6px}`}</style>
    </div>
  );
}
