import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

/**
 * Arbitration reveal — a purely COSMETIC theatrical animation that plays an ALREADY-DECIDED
 * arbitration outcome. It never chooses the winner: resolveArbitration decides the side + wage,
 * and this component only animates that pre-decided result.
 *
 * PORTED from the standalone Claude Design file ("Arbitrator Reveal (standalone).html"), which
 * was authored in Claude Design's proprietary `class Component extends DCLogic` runtime. This is a
 * native React 19 port — NO DCLogic / Design runtime is imported. The stage markup is injected
 * verbatim (dangerouslySetInnerHTML of trusted static HTML, preview controls removed) and the
 * animation is driven imperatively through queried `data-el` refs, exactly as the original
 * cacheEls()/playVerdict()/reset()/startSmoke() did — so it looks identical to the standalone.
 */

export type ArbitrationOutcome = 'baxter' | 'union'
export type ArbitrationRevealHandle = {
  /** Play the theatrical reveal for a PRE-DECIDED outcome. Baxter shows the fixed $8.67 award;
   *  union shows the injected wage (the group's 1978 wage that resolveArbitration wrote). */
  playVerdict: (outcome: ArbitrationOutcome, unionWage?: string | number) => void
  reset: () => void
}
export type ArbitrationRevealProps = {
  /** When set, the reveal AUTO-PLAYS this PRE-DECIDED outcome ~400ms after mount — matching the
   *  source's autoPlay. Prop-driven (not a parent effect calling the ref) so the beats are scheduled
   *  inside this component's own effect, immune to the StrictMode cross-component cleanup race. */
  outcome?: ArbitrationOutcome
  unionWage?: string | number
}

// Outcome copy + accent palette — verbatim from the source COPY (baxter=amber, union=green).
const COPY: Record<ArbitrationOutcome, { verdict: string; sub: string; accent: string }> = {
  baxter: { verdict: 'Management Prevails', sub: 'Baxter Manufacturing’s terms are upheld.', accent: '#f0ac3a' },
  union:  { verdict: 'The Union Prevails',  sub: 'The union’s terms are upheld.',          accent: '#35e08a' },
}
const BUILD = '#34c0c8' // eerie neutral glow during the build, before the verdict lands

// The 3 keyframes from the source <style> (head pulse, eye flicker, micro-shake).
const KEYFRAMES = `
@keyframes arb-headPulse {
  0%, 100% { transform: scale(1); filter: brightness(1) blur(0.4px); }
  50%      { transform: scale(1.035); filter: brightness(1.22) blur(0.4px); }
}
@keyframes arb-eyeFlicker {
  0%, 100% { opacity: 1; }
  45%      { opacity: 0.78; }
  62%      { opacity: 1; }
  78%      { opacity: 0.86; }
}
@keyframes arb-microShake {
  0%, 100% { transform: translate(0, 0); }
  25%      { transform: translate(-1.5px, 1px); }
  50%      { transform: translate(1.5px, -1px); }
  75%      { transform: translate(-1px, -1.5px); }
}`

// Stage markup — VERBATIM from the standalone template, preview controls removed. Trusted static
// HTML (no user input) → dangerouslySetInnerHTML is safe here.
const STAGE_HTML = `
<div data-el="stage" style="position:relative; width:100%; height:100vh; min-height:640px; overflow:hidden; background:radial-gradient(ellipse 120% 92% at 50% 40%, #0b1519 0%, #06090c 56%, #030405 100%); font-family:'Space Grotesk',system-ui,sans-serif; color:#eaf3ef; user-select:none; --glow:#34c0c8; --accent:#34c0c8;">

  <!-- ATMOSPHERE: drifting smoke, drawn entirely on canvas (no image assets) -->
  <canvas data-el="smoke" style="position:absolute; inset:0; width:100%; height:100%; z-index:1; pointer-events:none;"></canvas>

  <!-- edge vignette -->
  <div style="position:absolute; inset:0; z-index:2; pointer-events:none; background:radial-gradient(ellipse 78% 70% at 50% 42%, transparent 55%, rgba(2,4,6,0.78) 100%);"></div>

  <!-- THE DISEMBODIED HEAD (pure CSS glow) -->
  <div style="position:absolute; left:50%; top:31%; transform:translate(-50%,-50%); z-index:3;">
    <div data-el="headWrap" style="position:relative; opacity:0; transform:translateY(50px) scale(0.92); transition:opacity 2.1s ease, transform 2.1s cubic-bezier(.2,.7,.2,1); will-change:opacity,transform;">
      <div data-el="glowCore" style="position:absolute; left:50%; top:44%; transform:translate(-50%,-50%); width:660px; height:660px; border-radius:50%; z-index:1; opacity:0.22; transition:opacity 1.6s ease; background:radial-gradient(circle, color-mix(in srgb, var(--glow) 36%, transparent) 0%, transparent 62%); filter:blur(24px); pointer-events:none;"></div>

      <div data-el="head" style="position:relative; z-index:2; width:300px; height:378px; border-radius:50% 50% 47% 47% / 56% 56% 44% 44%; filter:blur(0.4px); background:radial-gradient(ellipse 62% 66% at 50% 42%, color-mix(in srgb, var(--glow) 86%, #ffffff) 0%, var(--glow) 20%, color-mix(in srgb, var(--glow) 32%, #04070a) 50%, rgba(4,7,10,0) 74%); box-shadow:0 0 80px 6px color-mix(in srgb, var(--glow) 46%, transparent), 0 0 200px 52px color-mix(in srgb, var(--glow) 20%, transparent);">
        <!-- brow ridge -->
        <div style="position:absolute; top:29%; left:19%; width:74px; height:11px; border-radius:6px; background:rgba(3,6,8,0.62); transform:rotate(13deg); filter:blur(1px);"></div>
        <div style="position:absolute; top:29%; right:19%; width:74px; height:11px; border-radius:6px; background:rgba(3,6,8,0.62); transform:rotate(-13deg); filter:blur(1px);"></div>
        <!-- eyes -->
        <div data-el="eyeL" style="position:absolute; top:35%; left:23%; width:54px; height:66px; border-radius:52% 52% 50% 50%; transform:rotate(11deg); animation:arb-eyeFlicker 3.4s ease-in-out infinite; background:radial-gradient(circle at 50% 45%, #ffffff 0%, color-mix(in srgb, var(--glow) 70%, #ffffff) 34%, var(--glow) 70%, transparent 100%); box-shadow:0 0 26px 6px color-mix(in srgb, var(--glow) 65%, transparent);"></div>
        <div data-el="eyeR" style="position:absolute; top:35%; right:23%; width:54px; height:66px; border-radius:52% 52% 50% 50%; transform:rotate(-11deg); animation:arb-eyeFlicker 3.4s ease-in-out infinite 0.4s; background:radial-gradient(circle at 50% 45%, #ffffff 0%, color-mix(in srgb, var(--glow) 70%, #ffffff) 34%, var(--glow) 70%, transparent 100%); box-shadow:0 0 26px 6px color-mix(in srgb, var(--glow) 65%, transparent);"></div>
        <!-- mouth -->
        <div data-el="mouth" style="position:absolute; bottom:19%; left:50%; margin-left:-62px; width:124px; height:28px; border-radius:50%; opacity:0.35; transform:scaleY(0.5); transition:transform .8s ease, opacity .8s ease; background:radial-gradient(ellipse at 50% 50%, color-mix(in srgb, var(--glow) 88%, #ffffff) 0%, var(--glow) 45%, transparent 78%); box-shadow:0 0 30px 4px color-mix(in srgb, var(--glow) 50%, transparent);"></div>
      </div>
    </div>
  </div>

  <!-- STATUS LINE during the build -->
  <div data-el="status" style="position:absolute; left:0; right:0; top:57%; text-align:center; z-index:4; opacity:0; transition:opacity .8s ease; font-family:'Space Mono',monospace; text-transform:uppercase; letter-spacing:0.28em; font-size:clamp(11px,1.35vw,15px); color:color-mix(in srgb, var(--glow) 72%, #dff1ea);"></div>

  <!-- PROSCENIUM + CURTAIN REVEAL holding the verdict -->
  <div data-el="frame" style="position:absolute; left:50%; bottom:4%; transform:translateX(-50%); width:min(1120px,92%); height:auto; padding:clamp(16px,2.6vh,34px) 0; z-index:5; display:flex; align-items:center; justify-content:center; overflow:hidden; border-radius:10px; border:1px solid rgba(255,255,255,0.05); background:linear-gradient(180deg, rgba(10,16,18,0.35), rgba(4,7,9,0.55)); box-shadow:inset 0 0 130px rgba(0,0,0,0.65);">

    <!-- verdict card (behind the curtains) -->
    <div data-el="card" style="position:relative; z-index:3; width:88%; max-width:900px; text-align:center; padding:clamp(20px,3vw,40px); border:1px solid color-mix(in srgb, var(--accent) 45%, transparent); border-radius:8px; background:radial-gradient(ellipse at 50% 0%, color-mix(in srgb, var(--accent) 9%, rgba(6,10,12,0.5)) 0%, rgba(5,8,10,0.72) 70%); box-shadow:0 0 60px color-mix(in srgb, var(--accent) 24%, transparent), inset 0 0 40px rgba(0,0,0,0.4); opacity:0; transform:translateY(24px) scale(0.96); transition:opacity .7s ease, transform .7s cubic-bezier(.2,.8,.2,1), border-color .5s ease, box-shadow .5s ease;">
      <div style="font-family:'Space Mono',monospace; text-transform:uppercase; letter-spacing:0.4em; font-size:clamp(11px,1.2vw,14px); color:color-mix(in srgb, var(--accent) 78%, #ffffff);">The Arbitrator Has Spoken</div>
      <div data-el="cardVerdict" style="margin-top:14px; font-family:'Cinzel',serif; font-weight:700; line-height:1.02; font-size:clamp(38px,7vmin,100px); color:#f5faf7; text-shadow:0 0 30px color-mix(in srgb, var(--accent) 55%, transparent);">The Verdict</div>
      <div data-el="cardSub" style="margin-top:12px; font-size:clamp(15px,1.7vw,22px); color:#c6d3ce;"></div>
      <div style="margin-top:clamp(16px,2.4vw,30px); display:flex; flex-direction:column; align-items:center; gap:4px;">
        <div style="font-family:'Space Mono',monospace; text-transform:uppercase; letter-spacing:0.35em; font-size:clamp(10px,1vw,13px); color:color-mix(in srgb, var(--accent) 70%, #cfe);">Binding Wage</div>
        <div data-el="cardWage" style="font-family:'Cinzel',serif; font-weight:600; font-size:clamp(30px,5.4vmin,74px); color:var(--accent); text-shadow:0 0 34px color-mix(in srgb, var(--accent) 60%, transparent);">$&mdash;</div>
      </div>
      <div style="margin-top:clamp(14px,2vw,26px); font-family:'Space Mono',monospace; letter-spacing:0.18em; font-size:clamp(10px,1vw,12px); color:#6f817b;">This award is final and binding &middot; Labor Arbitration</div>
    </div>

    <!-- valance -->
    <div style="position:absolute; top:0; left:0; right:0; height:14px; z-index:6; background:linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 40%, transparent), transparent); box-shadow:0 2px 18px color-mix(in srgb, var(--accent) 30%, transparent);"></div>

    <!-- curtains -->
    <div data-el="curtainL" style="position:absolute; top:0; bottom:0; left:0; width:51%; z-index:5; transform:translateX(0); transition:transform 1.15s cubic-bezier(.7,0,.15,1); background:repeating-linear-gradient(90deg, rgba(0,0,0,0.55) 0 20px, rgba(255,255,255,0.022) 20px 24px, rgba(0,0,0,0.55) 24px 44px), linear-gradient(180deg, #0d1116, #06090d); box-shadow:inset -30px 0 50px rgba(0,0,0,0.7), inset 0 0 60px rgba(0,0,0,0.4);"></div>
    <div data-el="curtainR" style="position:absolute; top:0; bottom:0; right:0; width:51%; z-index:5; transform:translateX(0); transition:transform 1.15s cubic-bezier(.7,0,.15,1); background:repeating-linear-gradient(90deg, rgba(0,0,0,0.55) 0 20px, rgba(255,255,255,0.022) 20px 24px, rgba(0,0,0,0.55) 24px 44px), linear-gradient(180deg, #0d1116, #06090d); box-shadow:inset 30px 0 50px rgba(0,0,0,0.7), inset 0 0 60px rgba(0,0,0,0.4);"></div>
  </div>

  <!-- REVEAL FLASH -->
  <div data-el="flash" style="position:absolute; inset:0; z-index:20; pointer-events:none; opacity:0; transition:opacity .55s ease; background:radial-gradient(ellipse at 50% 42%, #ffffff, #ffffff 30%, transparent 72%); mix-blend-mode:screen;"></div>
</div>`

export const ArbitrationReveal = forwardRef<ArbitrationRevealHandle, ArbitrationRevealProps>(function ArbitrationReveal({ outcome, unionWage }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rootRef      = useRef<HTMLElement | null>(null)
  const elsRef       = useRef<Record<string, HTMLElement>>({})
  const timersRef    = useRef<number[]>([])
  const rafRef       = useRef<number | null>(null)
  const resizeRef    = useRef<(() => void) | null>(null)
  const smokeRef     = useRef(1)

  // ---- helpers (ported 1:1 from the DCLogic class) ----
  const setGlow   = (c: string) => rootRef.current?.style.setProperty('--glow', c)
  const setAccent = (c: string) => rootRef.current?.style.setProperty('--accent', c)
  const after     = (ms: number, fn: () => void) => { timersRef.current.push(window.setTimeout(fn, ms)) }
  const clearTimers = () => { timersRef.current.forEach(clearTimeout); timersRef.current = [] }

  // ---- AUDIO HOOK — Gary's owned reveal clip wires here later. NO audio file is bundled this
  // slice; do not add one. (Fires on the reveal beat, exactly as the source playAudio hook did.)
  const playAudio = (_outcome: ArbitrationOutcome) => { /* DEV: trigger reveal sound here later. */ }

  const reset = () => {
    clearTimers()
    smokeRef.current = 1
    const e = elsRef.current
    if (!e.headWrap) return
    setGlow(BUILD); setAccent(BUILD)
    e.headWrap.style.animation = 'none'
    e.headWrap.style.opacity   = '0'
    e.headWrap.style.transform = 'translateY(50px) scale(0.92)'
    e.head.style.animation     = 'none'
    e.glowCore.style.opacity   = '0.22'
    e.mouth.style.transform    = 'scaleY(0.5)'
    e.mouth.style.opacity      = '0.35'
    e.status.style.opacity     = '0'
    e.flash.style.opacity      = '0'
    e.curtainL.style.transform = 'translateX(0)'
    e.curtainR.style.transform = 'translateX(0)'
    e.card.style.opacity       = '0'
    e.card.style.transform     = 'translateY(24px) scale(0.96)'
  }

  const playVerdict = (playOutcome: ArbitrationOutcome, playUnionWage?: string | number) => {
    const e = elsRef.current
    if (!e.headWrap) return
    const o: ArbitrationOutcome = playOutcome === 'baxter' ? 'baxter' : 'union'
    reset()
    const C = COPY[o]

    // BEAT 1->2  SUMMON: head fades up out of the smoke, begins to pulse
    after(80, () => {
      e.glowCore.style.opacity   = '0.5'
      e.headWrap.style.opacity   = '1'
      e.headWrap.style.transform = 'translateY(0) scale(1)'
      e.status.textContent       = 'The arbitrator stirs from the dark…'
      e.status.style.opacity     = '0.9'
    })
    after(2300, () => { e.head.style.animation = 'arb-headPulse 3.2s ease-in-out infinite' })

    // BEAT 3  CONSIDER: it weighs the evidence — glow builds, ground trembles
    after(2700, () => {
      smokeRef.current           = 1.9
      e.glowCore.style.opacity   = '0.85'
      e.headWrap.style.animation = 'arb-microShake 0.18s ease-in-out infinite'
      e.head.style.animation     = 'arb-headPulse 1.4s ease-in-out infinite'
      e.mouth.style.transform    = 'scaleY(1)'
      e.mouth.style.opacity      = '0.82'
      e.status.textContent       = 'It weighs the evidence… judgment nears.'
    })

    // BEAT 4->5  REVEAL: flash, curtains part, verdict lands and holds
    after(4700, () => {
      e.headWrap.style.animation = 'none'
      e.headWrap.style.transform = 'translateY(0) scale(1.05)'
      e.status.style.opacity     = '0'

      setGlow(C.accent); setAccent(C.accent)
      e.flash.style.background = 'radial-gradient(ellipse at 50% 42%, #ffffff, ' + C.accent + ' 34%, transparent 74%)'
      e.flash.style.opacity    = '0.95'
      after(150, () => { e.flash.style.opacity = '0' })

      e.cardVerdict.textContent = C.verdict
      e.cardSub.textContent     = C.sub
      // Baxter = the fixed $8.67 award; union = the injected wage resolveArbitration wrote. Never
      // recomputed here — a reveal of the real decided value. (Falls back to em-dash, never a
      // template placeholder — the caller always passes the real union wage.)
      const wage = o === 'baxter'
        ? '8.67'
        : (playUnionWage != null && String(playUnionWage).trim() !== '' ? String(playUnionWage).trim() : '—')
      e.cardWage.textContent = '$' + wage + ' / hr'

      e.curtainL.style.transform = 'translateX(-108%)'
      e.curtainR.style.transform = 'translateX(108%)'

      after(280, () => {
        e.card.style.opacity   = '1'
        e.card.style.transform = 'translateY(0) scale(1)'
      })

      smokeRef.current = 1.4
      playAudio(o) // <-- audio hook fires on the reveal
    })
  }

  // ---- canvas smoke (portable, no image assets) — ported verbatim ----
  const startSmoke = () => {
    const c = elsRef.current.smoke as HTMLCanvasElement | undefined
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const resize = () => { c.width = Math.max(1, c.clientWidth * dpr); c.height = Math.max(1, c.clientHeight * dpr) }
    resize()
    resizeRef.current = resize
    window.addEventListener('resize', resize)

    const hexA = (hex: string, a: number) => {
      let h = (hex || '#34c0c8').trim().replace('#', '')
      if (h.length === 3) h = h.split('').map(ch => ch + ch).join('')
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'
    }
    const mkParticle = (W: number, H: number, seed: boolean) => ({
      x: Math.random() * W,
      y: seed ? (H * (0.5 + Math.random() * 0.6)) : (H * (0.92 + Math.random() * 0.2)),
      r: (70 + Math.random() * 150) * dpr,
      vx: (Math.random() - 0.5) * 0.35 * dpr,
      vy: -(0.25 + Math.random() * 0.5) * dpr,
      baseA: 0.35 + Math.random() * 0.5,
      life: 0.5 + Math.random() * 0.5,
    })

    const P: ReturnType<typeof mkParticle>[] = []
    for (let i = 0; i < 44; i++) P.push(mkParticle(c.width, c.height, true))
    const tick = () => {
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.globalCompositeOperation = 'lighter'
      const glow = (getComputedStyle(rootRef.current as Element).getPropertyValue('--glow') || '#34c0c8').trim()
      const inten = smokeRef.current || 1
      for (const p of P) {
        p.x += p.vx * inten; p.y += p.vy * inten; p.life -= 0.0015
        if (p.life <= 0 || p.y < -p.r) Object.assign(p, mkParticle(c.width, c.height, false))
        const a = Math.max(0, Math.min(1, p.life)) * p.baseA * Math.min(inten, 2.2)
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r)
        g.addColorStop(0, hexA(glow, a * 0.42))
        g.addColorStop(0.4, hexA(glow, a * 0.14))
        g.addColorStop(1, hexA(glow, 0))
        ctx.fillStyle = g
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill()
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    tick()
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // Set the markup IMPERATIVELY (not via React's dangerouslySetInnerHTML). React's StrictMode
    // double-renders the tree and re-creates dangerouslySetInnerHTML children, which left elsRef
    // pointing at the orphaned first-render nodes (beats fired on detached DOM). Owning innerHTML
    // here — re-set on each StrictMode effect setup — guarantees cacheEls captures the LIVE nodes.
    container.innerHTML = STAGE_HTML
    const root = container.querySelector('[data-el="stage"]') as HTMLElement | null
    rootRef.current = root
    const els: Record<string, HTMLElement> = {}
    root?.querySelectorAll<HTMLElement>('[data-el]').forEach(n => { els[n.dataset.el as string] = n })
    elsRef.current = els
    reset()
    startSmoke()
    // Prop-driven auto-play (matches the source's autoPlay: after(400, …)). Scheduling the play
    // inside THIS effect — after cacheEls/reset — keeps the beat timers in the same lifecycle as the
    // cleanup, so the StrictMode double-invoke re-schedules them cleanly (no cross-component race).
    if (outcome) after(400, () => playVerdict(outcome, unionWage))
    return () => {
      clearTimers()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (resizeRef.current) window.removeEventListener('resize', resizeRef.current)
      container.innerHTML = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useImperativeHandle(ref, () => ({ playVerdict, reset }), [])

  return (
    <>
      <style>{KEYFRAMES}</style>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </>
  )
})
