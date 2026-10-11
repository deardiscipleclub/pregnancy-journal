/* Growing in the Secret Place: the member journal.
   Plain JavaScript, no build step. Data lives in Supabase; when Supabase
   isn't configured yet the app runs in preview mode (local content, saved
   in this browser only). */
(function () {
  "use strict";

  const CFG = window.GISP_CONFIG || {};
  const LIVE = Boolean(CFG.supabaseUrl && CFG.supabaseAnonKey);
  const FIRST_WEEK = 6;
  const LAST_WEEK = 40;
  const NUMBER_WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const TENS = { 20: "twenty", 30: "thirty", 40: "forty" };

  const SECTIONS = [
    { id: "scripture", label: "Scripture" },
    { id: "baby", label: "Baby this week" },
    { id: "prayers", label: "Prayers" },
    { id: "reflection", label: "Reflection" },
    { id: "secret", label: "Secret Place" },
    { id: "letter", label: "Dear Baby" },
    { id: "memories", label: "Memories" },
    { id: "blessing", label: "Blessing" },
  ];

  const app = document.getElementById("app");
  const state = { user: null, profile: {}, isMember: false, index: null, progress: null };

  /* ------------------------------------------------------------ helpers */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function weekWords(n) {
    if (n < 20) return NUMBER_WORDS[n];
    const tens = Math.floor(n / 10) * 10;
    return n % 10 ? `${TENS[tens]}-${NUMBER_WORDS[n % 10]}` : TENS[tens];
  }

  function paras(text) {
    const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
    let html = "";
    let list = [];
    const flush = () => { if (list.length) { html += `<ul class="bullets">${list.join("")}</ul>`; list = []; } };
    for (const l of lines) {
      if (l.startsWith("• ")) { list.push(`<li>${esc(l.slice(2))}</li>`); continue; }
      flush();
      html += `<p>${esc(l)}</p>`;
    }
    flush();
    return html;
  }

  function babySize(week) {
    const m = /size of ((?:an? )?[^.,]+)/i.exec(week.babyThisWeek || "");
    return m ? m[1].trim() : "";
  }

  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2600);
  }

  function debounce(fn, ms) {
    let t;
    const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    d.flush = (...a) => { clearTimeout(t); return fn(...a); };
    return d;
  }

  function currentWeekFromDue(due) {
    if (!due) return null;
    const dueDate = new Date(due + "T12:00:00");
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const daysLeft = Math.round((dueDate - today) / 86400000);
    const gestDays = 280 - daysLeft;
    const w = Math.floor(gestDays / 7);
    return { weeks: w, days: gestDays % 7, clamped: Math.min(LAST_WEEK, Math.max(FIRST_WEEK, w)) };
  }

  async function resizeImage(file, maxSide, quality) {
    let source;
    try {
      source = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (_) {
      source = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      });
    }
    const w = source.width || source.naturalWidth;
    const h = source.height || source.naturalHeight;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  }

  /* ------------------------------------------------------------ data stores */

  // Live store: Supabase (auth, content, entries, photos).
  function makeLiveStore() {
    const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    const uid = () => state.user && state.user.id;
    const contentCache = new Map();

    return {
      live: true,
      async session() {
        const { data } = await sb.auth.getSession();
        return data.session ? data.session.user : null;
      },
      onAuth(cb) { sb.auth.onAuthStateChange((_e, s) => cb(s ? s.user : null)); },
      async sendCode(email) {
        const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
        if (error) throw error;
      },
      async verifyCode(email, token) {
        const { data, error } = await sb.auth.verifyOtp({ email, token, type: "email" });
        if (error) throw error;
        return data.user;
      },
      async signOut() { await sb.auth.signOut(); },
      async isMember() {
        const { data, error } = await sb.rpc("is_member");
        if (error) throw error;
        return Boolean(data);
      },
      async getProfile() {
        const { data } = await sb.from("profiles").select("*").eq("id", uid()).maybeSingle();
        return data || {};
      },
      async saveProfile(p) {
        const { error } = await sb.from("profiles").upsert({ ...p, id: uid(), updated_at: new Date().toISOString() });
        if (error) throw error;
      },
      async weekIndex() {
        const { data, error } = await sb.from("content").select("slug, ref:data->>scriptureRef, baby:data->>babyThisWeek").like("slug", "week-%");
        if (error) throw error;
        return data.map((r) => ({ week: Number(r.slug.slice(5)), scriptureRef: r.ref, babyThisWeek: r.baby }))
          .sort((a, b) => a.week - b.week);
      },
      async content(slug) {
        if (contentCache.has(slug)) return contentCache.get(slug);
        const { data, error } = await sb.from("content").select("data").eq("slug", slug).maybeSingle();
        if (error) throw error;
        const value = data ? data.data : null;
        contentCache.set(slug, value);
        return value;
      },
      async entries(slug) {
        let q = sb.from("entries").select("slug, field, body").eq("user_id", uid());
        if (slug) q = q.eq("slug", slug);
        const { data, error } = await q;
        if (error) throw error;
        return data;
      },
      async saveEntry(slug, field, body) {
        const { error } = await sb.from("entries").upsert(
          { user_id: uid(), slug, field, body, updated_at: new Date().toISOString() },
          { onConflict: "user_id,slug,field" },
        );
        if (error) throw error;
      },
      async photos(slug) {
        let q = sb.from("photos").select("id, slug, storage_path, caption, created_at").eq("user_id", uid()).order("created_at");
        if (slug) q = q.eq("slug", slug);
        const { data, error } = await q;
        if (error) throw error;
        if (!data.length) return [];
        const { data: signed } = await sb.storage.from("memory-photos").createSignedUrls(data.map((p) => p.storage_path), 3600);
        const urls = new Map((signed || []).map((s) => [s.path, s.signedUrl]));
        return data.map((p) => ({ ...p, url: urls.get(p.storage_path) }));
      },
      async addPhoto(slug, file) {
        const blob = await resizeImage(file, 2000, 0.85);
        const path = `${uid()}/${slug}/${crypto.randomUUID()}.jpg`;
        const up = await sb.storage.from("memory-photos").upload(path, blob, { contentType: "image/jpeg" });
        if (up.error) throw up.error;
        const { error } = await sb.from("photos").insert({ user_id: uid(), slug, storage_path: path });
        if (error) throw error;
      },
      async captionPhoto(id, caption) {
        const { error } = await sb.from("photos").update({ caption }).eq("id", id);
        if (error) throw error;
      },
      async removePhoto(photo) {
        await sb.storage.from("memory-photos").remove([photo.storage_path]);
        const { error } = await sb.from("photos").delete().eq("id", photo.id);
        if (error) throw error;
      },
    };
  }

  // Preview store: local devotional file + this browser's storage.
  function makeDemoStore() {
    const KEY = "gisp-demo-v1";
    const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) { return {}; } };
    const save = (db) => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (_) { toast("This browser is out of preview storage space."); } };
    const C = () => window.DEMO_CONTENT || {};
    return {
      live: false,
      async session() { return { id: "preview", email: "preview@example.com" }; },
      onAuth() {},
      async sendCode() {}, async verifyCode() { return { id: "preview" }; }, async signOut() { localStorage.removeItem(KEY); },
      async isMember() { return true; },
      async getProfile() { return load().profile || {}; },
      async saveProfile(p) { const db = load(); db.profile = { ...(db.profile || {}), ...p }; save(db); },
      async weekIndex() {
        return Object.keys(C()).filter((k) => k.startsWith("week-")).map((k) => C()[k]).sort((a, b) => a.week - b.week);
      },
      async content(slug) { return C()[slug] || null; },
      async entries(slug) {
        const e = load().entries || {};
        return Object.keys(e).map((k) => { const [s, f] = k.split("|"); return { slug: s, field: f, body: e[k] }; })
          .filter((r) => !slug || r.slug === slug);
      },
      async saveEntry(slug, field, body) { const db = load(); db.entries = db.entries || {}; db.entries[`${slug}|${field}`] = body; save(db); },
      async photos(slug) { return (load().photos || []).filter((p) => !slug || p.slug === slug); },
      async addPhoto(slug, file) {
        const blob = await resizeImage(file, 1100, 0.78);
        const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
        const db = load(); db.photos = db.photos || [];
        db.photos.push({ id: String(Date.now()), slug, url, caption: "", storage_path: "" });
        save(db);
      },
      async captionPhoto(id, caption) { const db = load(); const p = (db.photos || []).find((x) => x.id === id); if (p) p.caption = caption; save(db); },
      async removePhoto(photo) { const db = load(); db.photos = (db.photos || []).filter((x) => x.id !== photo.id); save(db); },
    };
  }

  function loadDemoContent() {
    return new Promise((resolve) => {
      if (window.DEMO_CONTENT) return resolve();
      const s = document.createElement("script");
      s.src = "../private/demo-content.js";
      s.onload = resolve;
      s.onerror = resolve;
      document.head.appendChild(s);
    });
  }

  let store;

  /* ------------------------------------------------------------ shell */
  function shell(inner, active) {
    const nav = [
      ["#/", "Weeks", "home"],
      ["#/legacy", "Legacy Book", "legacy"],
      ["#/account", "Account", "account"],
    ];
    return `
      <header class="topbar">
        <a class="wordmark" href="#/"><span class="script-soft">Growing in the Secret Place</span></a>
        <nav class="topnav" aria-label="Main">
          ${nav.map(([h, l, k]) => `<a href="${h}" ${active === k ? 'aria-current="page"' : ""}>${l}</a>`).join("")}
        </nav>
      </header>
      ${store.live ? "" : '<div class="demo-banner">Preview mode · saving to this browser only</div>'}
      <main id="main">${inner}</main>`;
  }

  function footer() {
    return `<footer class="footer">
      <p>© 2026 Lawrence Ministries, LLC. · Disciple Co. All rights reserved. Please don't share your login; invite a friend to get her own journal.</p>
      <p>Scripture quotations marked ESV are from the ESV® Bible (The Holy Bible, English Standard Version®), © 2001 by Crossway, a publishing ministry of Good News Publishers. Used by permission. All rights reserved. Scripture quotations taken from the Amplified® Bible (AMP), © 2015 by The Lockman Foundation. Used by permission.</p>
      <p>The fetal development summaries are for devotional encouragement and may vary for every pregnancy. They don't replace medical advice from your healthcare provider.</p>
    </footer>`;
  }

  /* ------------------------------------------------------------ journal entry widget */
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

  function entryHTML(slug, field, label, opts = {}) {
    const id = `e-${slug}-${field}`;
    return `
      <div class="entry ${opts.tall ? "tall" : ""}" data-slug="${esc(slug)}" data-field="${esc(field)}">
        <label class="sr" for="${id}">${esc(label)}</label>
        <textarea id="${id}" placeholder="${esc(opts.placeholder || "Write here, or tap Speak…")}"></textarea>
        <div class="interim" aria-live="polite"></div>
        <div class="entry-tools">
          <span class="save-state" aria-live="polite"></span>
          ${SpeechRec ? `<button type="button" class="mic" aria-pressed="false" aria-label="Speak your response for: ${esc(label)}"><span class="dot" aria-hidden="true"></span><span class="mic-label">Speak</span></button>` : ""}
        </div>
      </div>`;
  }

  function autoGrow(ta) {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + 2 + "px";
  }

  const pendingSaves = new Set();

  function wireEntries(root, values) {
    qsa(".entry", root).forEach((box) => {
      const slug = box.dataset.slug;
      const field = box.dataset.field;
      const ta = qs("textarea", box);
      const status = qs(".save-state", box);
      ta.value = values[field] || "";
      requestAnimationFrame(() => autoGrow(ta));

      const doSave = async () => {
        pendingSaves.delete(doSave);
        status.textContent = "Saving…";
        try {
          await store.saveEntry(slug, field, ta.value);
          values[field] = ta.value;
          status.textContent = "Saved";
          markStepper(root, values);
        } catch (err) {
          console.error(err);
          status.textContent = "Not saved yet";
          toast("We couldn't save just now. Your words are still here; we'll try again.");
          setTimeout(() => queueSave(), 4000);
        }
      };
      const queue = debounce(doSave, 900);
      const queueSave = () => { pendingSaves.add(doSave); status.textContent = "…"; queue(); };
      ta.addEventListener("input", () => { autoGrow(ta); queueSave(); });
      ta.addEventListener("blur", () => { if (pendingSaves.has(doSave)) queue.flush(); });

      const mic = qs(".mic", box);
      if (mic) wireDictation(mic, ta, qs(".interim", box), queueSave);
    });
  }

  function flushSaves() { pendingSaves.forEach((fn) => fn()); }
  window.addEventListener("pagehide", flushSaves);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSaves(); });

  let activeDictation = null;
  function wireDictation(btn, ta, interimEl, onChange) {
    let rec = null;
    let wanted = false;
    const label = qs(".mic-label", btn);

    const stop = () => {
      wanted = false;
      if (rec) rec.stop();
      btn.setAttribute("aria-pressed", "false");
      label.textContent = "Speak";
      interimEl.textContent = "";
      if (activeDictation === stop) activeDictation = null;
    };

    const start = () => {
      if (activeDictation) activeDictation();
      rec = new SpeechRec();
      rec.lang = navigator.language || "en-US";
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (ev) => {
        let interim = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (r.isFinal) {
            const said = r[0].transcript.trim();
            if (said) {
              const sep = ta.value && !/\s$/.test(ta.value) ? " " : "";
              ta.value += sep + said.charAt(0).toUpperCase() + said.slice(1);
              autoGrow(ta);
              onChange();
            }
          } else {
            interim += r[0].transcript;
          }
        }
        interimEl.textContent = interim;
      };
      rec.onerror = (ev) => {
        if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
          toast("Microphone access is off. You can allow it in your browser settings, or use your keyboard's mic key.");
          stop();
        }
      };
      rec.onend = () => { if (wanted) { try { rec.start(); } catch (_) { stop(); } } };
      wanted = true;
      try { rec.start(); } catch (_) { return; }
      btn.setAttribute("aria-pressed", "true");
      label.textContent = "Listening · tap to stop";
      activeDictation = stop;
    };

    btn.addEventListener("click", () => (btn.getAttribute("aria-pressed") === "true" ? stop() : start()));
  }

  /* ------------------------------------------------------------ views */

  function viewLoading(msg = "Gathering your pages…") {
    app.innerHTML = `<div class="loading">${esc(msg)}</div>`;
  }

  function viewSignIn(prefillEmail = "") {
    let email = prefillEmail;
    const purchase = CFG.purchaseUrl ? `<p class="form-note">Don't have the journal yet? <a href="${esc(CFG.purchaseUrl)}">Get Growing in the Secret Place</a>.</p>` : "";
    app.innerHTML = `
      <div class="signin">
        <div class="signin-cover" role="img" aria-label="Growing in the Secret Place, a pregnancy prayer and legacy journal by Rachel Lynn Lawrence"></div>
        <main class="signin-panel" id="main">
          <span class="caps muted">Pregnancy prayer + legacy journal</span>
          <h1>Welcome, <em>momma</em>.<br>Let's meet with Jesus.</h1>
          <form id="email-form" novalidate>
            <div class="field">
              <label for="email">Email you used at checkout</label>
              <input id="email" type="email" autocomplete="email" inputmode="email" required value="${esc(email)}">
            </div>
            <button class="btn" type="submit">Send my sign-in code</button>
            <p class="form-error" id="email-err" role="alert"></p>
          </form>
          <form id="code-form" hidden novalidate>
            <p>We sent a 6-digit code to <strong id="sent-to"></strong>. It can take a minute to arrive.</p>
            <div class="field">
              <label for="code">Sign-in code</label>
              <input id="code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required>
            </div>
            <button class="btn" type="submit">Open my journal</button>
            <p class="form-error" id="code-err" role="alert"></p>
            <button class="linkish" type="button" id="back">Use a different email</button>
          </form>
          ${purchase}
        </main>
      </div>`;

    const emailForm = qs("#email-form");
    const codeForm = qs("#code-form");
    emailForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      email = qs("#email").value.trim().toLowerCase();
      const err = qs("#email-err");
      err.textContent = "";
      if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = "Please enter your email address."; return; }
      const btn = qs("button", emailForm);
      btn.disabled = true;
      try {
        await store.sendCode(email);
        qs("#sent-to").textContent = email;
        emailForm.hidden = true;
        codeForm.hidden = false;
        qs("#code").focus();
      } catch (ex) {
        console.error(ex);
        err.textContent = /rate/i.test(ex.message || "") ? "Too many tries for now. Please wait a few minutes and try again." : "We couldn't send a code just now. Please try again.";
      } finally { btn.disabled = false; }
    });
    codeForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const token = qs("#code").value.replace(/\D/g, "");
      const err = qs("#code-err");
      err.textContent = "";
      const btn = qs("button[type=submit]", codeForm);
      btn.disabled = true;
      try {
        state.user = await store.verifyCode(email, token);
        await afterSignIn();
      } catch (ex) {
        console.error(ex);
        err.textContent = "That code didn't work. Check the newest email, or send a new code.";
      } finally { btn.disabled = false; }
    });
    qs("#back").addEventListener("click", () => { codeForm.hidden = true; emailForm.hidden = false; qs("#email").focus(); });
  }

  function viewNotMember() {
    const email = state.user && state.user.email;
    app.innerHTML = `
      <div class="wrap reading">
        <h1><span class="script-soft">Almost there</span></h1>
        <div class="paper stack">
          <p>We couldn't find a journal purchase for <strong>${esc(email)}</strong>.</p>
          <p>If you bought it with a different email, sign out and sign in with that one. If you just checked out, give it a minute and refresh this page.</p>
          <div class="complete-row" style="justify-content:flex-start">
            ${CFG.purchaseUrl ? `<a class="btn" href="${esc(CFG.purchaseUrl)}">Get the journal</a>` : ""}
            <button class="btn ghost" id="refresh">Check again</button>
            <button class="btn ghost" id="signout">Sign out</button>
          </div>
          <p class="form-note">Need help? Email <a href="mailto:${esc(CFG.supportEmail)}">${esc(CFG.supportEmail)}</a>.</p>
        </div>
      </div>`;
    qs("#refresh").addEventListener("click", () => location.reload());
    qs("#signout").addEventListener("click", async () => { await store.signOut(); location.hash = "#/"; location.reload(); });
  }

  async function loadProgress() {
    const rows = await store.entries();
    const p = {};
    for (const r of rows) {
      if (!r.body) continue;
      p[r.slug] = p[r.slug] || { started: false, done: false };
      if (r.field === "_done") p[r.slug].done = r.body === "1";
      else p[r.slug].started = true;
    }
    state.progress = p;
    return p;
  }

  async function viewHome() {
    viewLoading();
    const [index, progress] = await Promise.all([state.index || store.weekIndex(), loadProgress()]);
    state.index = index;
    const now = currentWeekFromDue(state.profile.due_date);
    const name = state.profile.first_name ? `, ${state.profile.first_name}` : "";
    let resume = now ? now.clamped : null;
    if (!resume) {
      const firstOpen = index.find((w) => !(progress[`week-${w.week}`] || {}).done);
      resume = firstOpen ? firstOpen.week : FIRST_WEEK;
    }

    const tile = (w) => {
      const p = progress[`week-${w.week}`] || {};
      const cls = ["week-tile", p.done ? "done" : "", now && now.clamped === w.week ? "current" : ""].join(" ");
      const st = p.done ? "✓ Complete" : p.started ? "Started" : "";
      const size = babySize(w);
      return `<a class="${cls}" href="#/week/${w.week}">
        <span class="script-soft">week ${weekWords(w.week)}</span>
        ${size ? `<span class="size">size of ${esc(size)}</span>` : ""}
        ${st ? `<span class="state">${st}</span>` : ""}
      </a>`;
    };
    const tri = (title, from, to) => `
      <section class="trimester">
        <h2 class="caps">${title}</h2>
        <div class="week-grid">${index.filter((w) => w.week >= from && w.week <= to).map(tile).join("")}</div>
      </section>`;

    const dueBox = now ? "" : `
      <div class="duebox">
        <form id="due-form">
          <div class="field">
            <label for="due">When is your baby due?</label>
            <input type="date" id="due" required>
          </div>
          <button class="btn small" type="submit">Find my week</button>
        </form>
        <p class="form-note" style="margin:.6em 0 0">Optional. It helps us open the right week for you each time.</p>
      </div>`;

    const along = now ? (now.weeks < FIRST_WEEK ? "Your journal begins at week six. Start with the welcome pages for now." :
      now.weeks > LAST_WEEK ? "Your due date has come. How is your heart?" :
        `You're about ${now.weeks} weeks${now.days ? ` and ${now.days} day${now.days > 1 ? "s" : ""}` : ""} along.`) : "Start where you are.";

    app.innerHTML = shell(`
      <div class="wrap wide">
        <div class="hello">
          <span class="script-soft">Hello${esc(name)}</span>
          <h1>${esc(along)}</h1>
        </div>
        <a class="now-card" href="#/week/${resume}">
          <div>
            <span class="caps">${now ? "This week" : "Continue"}</span>
            <span class="script">week ${weekWords(resume)}</span>
            <p>${esc((index.find((w) => w.week === resume) || {}).scriptureRef || "")}</p>
          </div>
          <span class="btn">Open</span>
        </a>
        ${dueBox}
        <div class="extras">
          <a class="extra-tile" href="#/page/welcome"><span class="script-soft">Welcome</span><span>A letter from Rachel</span></a>
          <a class="extra-tile" href="#/page/how-to-use"><span class="script-soft">How to use</span><span>Secret Place Moments and listening prayer</span></a>
        </div>
        ${tri("First trimester", 6, 13)}
        ${tri("Second trimester", 14, 27)}
        ${tri("Third trimester", 28, 40)}
        <div class="extras">
          <a class="extra-tile" href="#/birth"><span class="script-soft">Baby's Birth</span><span>Your birth story, details, and first photos</span></a>
          <a class="extra-tile" href="#/legacy"><span class="script-soft">Legacy Book</span><span>Every prayer and photo, ready to print</span></a>
          <a class="extra-tile" href="#/page/congratulations"><span class="script-soft">Congratulations</span><span>For when you reach the end</span></a>
        </div>
      </div>
      ${footer()}`, "home");

    const form = qs("#due-form");
    if (form) form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const due = qs("#due").value;
      if (!due) return;
      state.profile.due_date = due;
      await store.saveProfile({ due_date: due });
      viewHome();
    });
  }

  /* ---- week sections ---- */
  function splitAmen(text) {
    const m = /\s*In Jesus['’]\s*name,?\s*Amen\.?\s*$/i.exec(text || "");
    return m ? { body: text.slice(0, m.index), amen: true } : { body: text, amen: false };
  }

  function sectionScripture(w) {
    return `
      <section class="scripture" aria-label="Scripture for week ${w.week}">
        <div>
          <h2 class="ref">${esc(w.scriptureRef)}</h2>
          <blockquote>${esc(w.scripture)}</blockquote>
        </div>
        <span class="wk" aria-hidden="true">week ${weekWords(w.week)}</span>
      </section>`;
  }

  function sectionBaby(w, slug) {
    return `
      <section>
        <div class="paper">
          <h2 class="duo"><span class="script">Baby</span><span class="tail">this week</span></h2>
          ${paras(w.babyThisWeek)}
          <h2 class="duo" style="margin-top:1.6em"><span class="script">Wonder</span><span class="tail">of our Creator</span></h2>
          ${paras(w.wonder)}
        </div>
        <div class="grey-band">
          <div class="prompt-line">
            <span class="script" aria-hidden="true">Pause + Reflect:</span>
            <p id="pr-${w.week}">${esc(w.pauseReflect)}</p>
          </div>
          ${entryHTML(slug, "pause", w.pauseReflect)}
        </div>
      </section>`;
  }

  function sectionPrayers(w) {
    const one = (title, text) => {
      const { body, amen } = splitAmen(text);
      return `<div class="prayer">
        <h2 class="duo"><span class="script">prayer</span><span class="tail">${title}</span></h2>
        ${paras(body)}
        ${amen ? `<p class="amen">In Jesus' name, Amen.</p>` : ""}
      </div>`;
    };
    return `<section class="paper">${one("for your baby", w.prayerForBaby)}${one("for you", w.prayerForYou)}</section>`;
  }

  function sectionReflection(w, slug) {
    const groups = [["physically", "Physically", "phys"], ["emotionally", "Emotionally", "emo"], ["spiritually", "Spiritually", "spir"]];
    const r = w.reflection || {};
    return `
      <section class="paper">
        <h2 class="duo"><span class="script">Momma</span><span class="tail caps">Reflection</span></h2>
        ${groups.map(([k, label, key]) => {
          const qsList = r[k] || [];
          if (!qsList.length) return "";
          return `<div class="refl-group">
            <h3>${label}</h3>
            ${qsList.map((q, i) => `<p class="q">${esc(q)}</p>${entryHTML(slug, `${key}-${i}`, `${label}: ${q}`)}`).join("")}
          </div>`;
        }).join("")}
      </section>`;
  }

  function sectionSecret(w, slug) {
    const lines = String(w.secretPlace || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const body = lines.map((l) => /^["“]/.test(l) ? `<p class="pray-quote">${esc(l)}</p>` : `<p>${esc(l)}</p>`).join("");
    return `
      <section class="paper">
        <h2 class="duo"><span class="script">Secret Place</span><span class="tail caps">Moment</span></h2>
        <div class="secret-steps">${body}</div>
        <div class="torn">${entryHTML(slug, "secret", "What I sensed in the Secret Place", { tall: true, placeholder: "Write what you sense here, or tap Speak…" })}</div>
      </section>`;
  }

  function sectionLetter(w, slug) {
    const lines = String(w.letter || "").split("\n").map((l) => l.trim()).filter(Boolean);
    let opening = "";
    if (/^Dear Baby,?/.test(lines[0] || "")) {
      opening = "Dear Baby,";
      lines[0] = lines[0].replace(/^Dear Baby,?\s*/, "");
      if (!lines[0]) lines.shift();
    }
    const tagline = (w.legacyLine || "").replace(/^Dear Baby,?\s*/, "") || "Write a letter your child can keep forever.";
    return `
      <section class="paper letter">
        ${opening ? `<p class="opening">${opening}</p>` : ""}
        ${lines.map((l) => `<p>${esc(l)}</p>`).join("")}
        <div class="legacy">
          <h3>legacy</h3>
          <div class="ornament" aria-hidden="true"><svg width="120" height="16" viewBox="0 0 120 16"><path d="M4 8h40M76 8h40" stroke="currentColor" stroke-width="1"/><path d="M24 8c4-5 8-5 10-4M24 8c4 5 8 5 10 4M96 8c-4-5-8-5-10-4M96 8c-4 5-8 5-10 4" fill="none" stroke="currentColor" stroke-width="1"/><path d="M60 13c-4.5-3-7-5.4-7-8a3.5 3.5 0 0 1 7-1.4A3.5 3.5 0 0 1 67 5c0 2.6-2.5 5-7 8z" fill="currentColor"/></svg></div>
          <p class="tagline">${esc(tagline)}</p>
          ${entryHTML(slug, "letter", "Letter to my baby", { tall: true, placeholder: "Dear little one…" })}
        </div>
      </section>`;
  }

  function sectionMemories(w, slug) {
    return `
      <section class="paper">
        <h2 class="center" style="margin:0"><span class="script-soft" style="font-size:3.6rem;font-weight:400">memories</span></h2>
        <p class="center muted">Keep this week's photos here: your bump, an ultrasound, the nursery, or an ordinary moment you want to remember.</p>
        <label class="upload-zone" id="drop">
          <input type="file" id="photo-input" accept="image/*" multiple>
          <span class="btn small">Add photos</span>
          <span class="muted" style="font-size:.9rem">From your camera roll or computer. Only you can see them.</span>
        </label>
        <div class="photo-grid" id="photos"><p class="muted">Loading photos…</p></div>
      </section>`;
  }

  function sectionBlessing(w, slug, done, total) {
    const t = w.closingTitle || {};
    const poem = String(w.closing || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const next = w.week < LAST_WEEK ? `<a class="btn ghost" href="#/week/${w.week + 1}">Go to week ${weekWords(w.week + 1)}</a>` : `<a class="btn ghost" href="#/birth">Baby's birth</a>`;
    return `
      <section class="blessing">
        <h2 class="blessing-title"><span class="script">${esc(t.script || "blessing")}</span>${t.caps ? `<span class="caps">${esc(t.caps)}</span>` : ""}</h2>
        ${t.subtitle ? `<p class="subtitle">${esc(t.subtitle)}</p>` : ""}
        <div class="poem">${poem.map((l) => `<p>${esc(l)}</p>`).join("")}</div>
        <div class="complete-row">
          <button class="btn" id="done-btn" aria-pressed="${done}">${done ? "✓ Week complete" : "Mark this week complete"}</button>
          ${next}
        </div>
      </section>`;
  }

  function markStepper(root, values) {
    const has = (prefixes) => Object.keys(values).some((k) => values[k] && prefixes.some((p) => k.startsWith(p)));
    const map = { baby: ["pause"], reflection: ["phys", "emo", "spir"], secret: ["secret"], letter: ["letter"] };
    qsa(".stepper a", document).forEach((a) => {
      const s = a.dataset.section;
      a.classList.toggle("has-words", Boolean(map[s] && has(map[s])));
    });
  }

  async function viewWeek(n, sectionId) {
    n = Math.min(LAST_WEEK, Math.max(FIRST_WEEK, Number(n) || FIRST_WEEK));
    const section = SECTIONS.find((s) => s.id === sectionId) ? sectionId : "scripture";
    const slug = `week-${n}`;
    if (!app.querySelector(`.week[data-week="${n}"]`)) viewLoading();
    const [w, rows] = await Promise.all([store.content(slug), store.entries(slug)]);
    if (!w) { app.innerHTML = shell(`<div class="wrap"><p>This week isn't available yet.</p></div>`, "home"); return; }
    const values = {};
    rows.forEach((r) => { values[r.field] = r.body; });
    const done = values._done === "1";

    const idx = SECTIONS.findIndex((s) => s.id === section);
    const prev = idx > 0 ? `#/week/${n}/${SECTIONS[idx - 1].id}` : n > FIRST_WEEK ? `#/week/${n - 1}/blessing` : "#/";
    const next = idx < SECTIONS.length - 1 ? `#/week/${n}/${SECTIONS[idx + 1].id}` : n < LAST_WEEK ? `#/week/${n + 1}` : "#/birth";
    const prevLabel = idx > 0 ? SECTIONS[idx - 1].label : n > FIRST_WEEK ? `Week ${n - 1}` : "All weeks";
    const nextLabel = idx < SECTIONS.length - 1 ? SECTIONS[idx + 1].label : n < LAST_WEEK ? `Week ${n + 1}` : "Baby's birth";

    const body = {
      scripture: () => sectionScripture(w),
      baby: () => sectionBaby(w, slug),
      prayers: () => sectionPrayers(w),
      reflection: () => sectionReflection(w, slug),
      secret: () => sectionSecret(w, slug),
      letter: () => sectionLetter(w, slug),
      memories: () => sectionMemories(w, slug),
      blessing: () => sectionBlessing(w, slug, done),
    }[section]();

    app.innerHTML = shell(`
      <div class="week" data-week="${n}">
        <aside class="band" aria-hidden="true">
          <div class="band-label"><span><span class="script">week ${weekWords(n)}</span> <span class="caps">${esc(SECTIONS[idx].label)}</span></span></div>
        </aside>
        <div class="week-main">
          <div class="week-head"><h1 class="script" style="font-weight:400;margin:0">week ${weekWords(n)}</h1></div>
          <nav class="stepper" aria-label="Sections of week ${n}">
            ${SECTIONS.map((s) => `<a href="#/week/${n}/${s.id}" data-section="${s.id}" ${s.id === section ? 'aria-current="step"' : ""}>${s.label}</a>`).join("")}
          </nav>
          <div class="sheet">
            ${body}
            <nav class="sheet-nav no-print" aria-label="Page">
              <a class="btn ghost" href="${prev}">← ${esc(prevLabel)}</a>
              <a class="btn" href="${next}">${esc(nextLabel)} →</a>
            </nav>
          </div>
          ${footer()}
        </div>
      </div>`, "home");

    const sheet = qs(".sheet");
    wireEntries(sheet, values);
    markStepper(sheet, values);
    const cur = qs('.stepper a[aria-current="step"]');
    if (cur) cur.scrollIntoView({ block: "nearest", inline: "center" });
    window.scrollTo({ top: 0 });

    if (section === "memories") wirePhotos(slug);
    if (section === "blessing") {
      qs("#done-btn").addEventListener("click", async (e) => {
        const isDone = e.currentTarget.getAttribute("aria-pressed") === "true";
        await store.saveEntry(slug, "_done", isDone ? "" : "1");
        e.currentTarget.setAttribute("aria-pressed", String(!isDone));
        e.currentTarget.textContent = isDone ? "Mark this week complete" : "✓ Week complete";
        if (!isDone) toast("You're doing great, momma. Keep going.");
      });
    }
  }

  async function wirePhotos(slug) {
    const grid = qs("#photos");
    const input = qs("#photo-input");
    const drop = qs("#drop");

    const render = async () => {
      const list = await store.photos(slug);
      if (!list.length) { grid.innerHTML = `<p class="muted" style="grid-column:1/-1">No photos yet this week.</p>`; return; }
      grid.innerHTML = list.map((p, i) => `
        <figure class="polaroid" style="--tilt:${[-1.2, .8, -.5, 1.1][i % 4]}deg">
          <img src="${esc(p.url)}" alt="${esc(p.caption || "Memory photo")}" loading="lazy">
          <input type="text" value="${esc(p.caption)}" placeholder="Add a caption" aria-label="Caption" data-id="${esc(p.id)}">
          <button type="button" class="linkish remove" data-id="${esc(p.id)}">Remove</button>
        </figure>`).join("");
      qsa("input[data-id]", grid).forEach((inp) => {
        const save = debounce(() => store.captionPhoto(inp.dataset.id, inp.value).catch(() => toast("Caption didn't save. Try again?")), 700);
        inp.addEventListener("input", save);
      });
      qsa("button.remove", grid).forEach((b) => b.addEventListener("click", async () => {
        if (!confirm("Remove this photo from your journal?")) return;
        const photo = list.find((p) => p.id === b.dataset.id);
        await store.removePhoto(photo);
        render();
      }));
    };

    const add = async (files) => {
      const imgs = Array.from(files).filter((f) => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name));
      if (!imgs.length) return;
      toast(`Adding ${imgs.length} photo${imgs.length > 1 ? "s" : ""}…`);
      for (const f of imgs) {
        try { await store.addPhoto(slug, f); } catch (err) { console.error(err); toast("One photo couldn't be added. Try a JPEG or PNG."); }
      }
      input.value = "";
      render();
    };

    input.addEventListener("change", () => add(input.files));
    ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
    drop.addEventListener("drop", (e) => add(e.dataTransfer.files));
    render();
  }

  async function viewPage(slug) {
    viewLoading();
    const c = await store.content(slug);
    if (!c) { location.hash = "#/"; return; }
    const titleParts = c.title.split(",");
    app.innerHTML = shell(`
      <div class="wrap reading">
        <h1><span class="script-soft">${esc(titleParts[0])}</span>${titleParts[1] ? `<span class="caps">${esc(titleParts[1].trim())}</span>` : ""}</h1>
        <div class="paper">
          ${c.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}
          ${c.signature ? `<p class="signature">${esc(c.signature)}</p>${c.signatureRole ? `<p class="muted" style="font-size:.9rem">${esc(c.signatureRole)}</p>` : ""}` : ""}
        </div>
        <div class="sheet-nav"><a class="btn ghost" href="#/">← All weeks</a>${slug === "welcome" ? `<a class="btn" href="#/page/how-to-use">How to use →</a>` : slug === "how-to-use" ? `<a class="btn" href="#/week/${(currentWeekFromDue(state.profile.due_date) || {}).clamped || FIRST_WEEK}">Begin →</a>` : ""}</div>
      </div>
      ${footer()}`, "home");
    window.scrollTo({ top: 0 });
  }

  async function viewBirth() {
    viewLoading();
    const slug = "birth";
    const [b, rows] = await Promise.all([store.content(slug), store.entries(slug)]);
    const values = {};
    rows.forEach((r) => { values[r.field] = r.body; });
    const c = b || { intro: "", details: [], name: [], firstSaw: [], scripture: "" };
    app.innerHTML = shell(`
      <div class="wrap">
        <div class="reading"><h1><span class="script-soft">Baby's Birth</span><span class="caps">Your story</span></h1></div>
        <section class="paper">
          <h2 class="duo"><span class="script">Birth</span><span class="tail">story</span></h2>
          <p>${esc(c.intro)}</p>
          ${entryHTML(slug, "story", "Birth story", { tall: true, placeholder: "The day you arrived…" })}
        </section>
        <section class="paper">
          <h2 class="duo"><span class="script">Birth</span><span class="tail">details</span></h2>
          <div class="details-grid">
            ${c.details.map((d, i) => `<div class="field"><label for="bd-${i}">${esc(d)}</label><input id="bd-${i}" data-field="detail-${i}" value="${esc(values[`detail-${i}`] || "")}"></div>`).join("")}
          </div>
        </section>
        <section class="paper">
          <h2 class="duo"><span class="script">The meaning</span><span class="tail">behind your name</span></h2>
          ${c.name.map((q, i) => `<p class="q" style="margin-top:1em">${esc(q)}</p>${entryHTML(slug, `name-${i}`, q)}`).join("")}
        </section>
        <section class="paper">
          <h2 class="duo"><span class="script">The first time</span><span class="tail">I saw you…</span></h2>
          ${c.firstSaw.map((q, i) => `<p class="q" style="margin-top:1em">${esc(q)}</p>${entryHTML(slug, `first-${i}`, q)}`).join("")}
        </section>
        <section class="paper">
          <h2 class="duo"><span class="script">Scripture</span><span class="tail">over your life…</span></h2>
          <p>${esc(c.scripture)}</p>
          ${entryHTML(slug, "scripture", c.scripture)}
        </section>
        ${sectionMemories({}, slug).replace("this week's photos here: your bump, an ultrasound, the nursery, or an ordinary moment you want to remember.", "your first photos together here.")}
        <div class="sheet-nav"><a class="btn ghost" href="#/week/40/blessing">← Week forty</a><a class="btn" href="#/page/congratulations">Congratulations →</a></div>
      </div>
      ${footer()}`, "home");
    const root = qs("main");
    wireEntries(root, values);
    qsa(".details-grid input", root).forEach((inp) => {
      const save = debounce(() => store.saveEntry(slug, inp.dataset.field, inp.value).catch(() => toast("That didn't save. Try again?")), 700);
      inp.addEventListener("input", save);
    });
    wirePhotos(slug);
    window.scrollTo({ top: 0 });
  }

  async function viewLegacy() {
    viewLoading("Binding your legacy book…");
    const [index, rows, photos] = await Promise.all([state.index || store.weekIndex(), store.entries(), store.photos()]);
    state.index = index;
    const bySlug = {};
    rows.forEach((r) => { if (r.body && r.field !== "_done") (bySlug[r.slug] = bySlug[r.slug] || {})[r.field] = r.body; });
    const photosBy = {};
    photos.forEach((p) => { (photosBy[p.slug] = photosBy[p.slug] || []).push(p); });

    const weeks = [];
    for (const w of index) {
      const slug = `week-${w.week}`;
      if (!bySlug[slug] && !photosBy[slug]) continue;
      weeks.push(await store.content(slug));
    }
    const qa = (q, a) => a ? `<p class="book-q">${esc(q)}</p><p class="book-a">${esc(a)}</p>` : "";
    const photoGrid = (slug) => (photosBy[slug] || []).length ? `<div class="book-photos">${photosBy[slug].map((p) => `<figure><img src="${esc(p.url)}" alt="${esc(p.caption || "Memory photo")}">${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ""}</figure>`).join("")}</div>` : "";

    const weekHTML = weeks.map((w) => {
      const slug = `week-${w.week}`;
      const v = bySlug[slug] || {};
      const r = w.reflection || {};
      const refl = [["physically", "phys"], ["emotionally", "emo"], ["spiritually", "spir"]]
        .map(([k, key]) => (r[k] || []).map((q, i) => qa(q, v[`${key}-${i}`])).join("")).join("");
      return `<article class="book-week">
        <h2>week ${weekWords(w.week)}</h2>
        <p class="ref">${esc(w.scriptureRef)}</p>
        ${qa(w.pauseReflect, v.pause)}
        ${refl}
        ${qa("In the Secret Place", v.secret)}
        ${v.letter ? `<p class="book-q">Dear Baby,</p><p class="book-a">${esc(v.letter)}</p>` : ""}
        ${photoGrid(slug)}
      </article>`;
    }).join("");

    const b = bySlug.birth || {};
    const birthC = (await store.content("birth")) || { details: [], name: [], firstSaw: [] };
    const birthHTML = (Object.keys(b).length || photosBy.birth) ? `<article class="book-week">
      <h2>baby's birth</h2>
      ${birthC.details.map((d, i) => b[`detail-${i}`] ? `<p class="book-a"><em>${esc(d)}:</em> ${esc(b[`detail-${i}`])}</p>` : "").join("")}
      ${qa("Birth story", b.story)}
      ${birthC.name.map((q, i) => qa(q, b[`name-${i}`])).join("")}
      ${birthC.firstSaw.map((q, i) => qa(q, b[`first-${i}`])).join("")}
      ${qa(birthC.scripture, b.scripture)}
      ${photoGrid("birth")}
    </article>` : "";

    const baby = state.profile.baby_nickname;
    app.innerHTML = shell(`
      <div class="wrap">
        <div class="no-print paper" style="margin-bottom:28px">
          <p style="margin:0 0 12px">Everything you've written and every photo you've added, gathered into one keepsake. Print it, or choose <em>Save as PDF</em> in the print window to keep a copy forever.</p>
          <button class="btn" id="print">Print or save as PDF</button>
        </div>
        <div class="paper">
          <div class="book-cover">
            <span class="caps muted">A legacy of prayer</span>
            <span class="script-soft">Growing in the Secret Place</span>
            <p class="muted">${baby ? `Written for ${esc(baby)}, ` : ""}before you were born, you were already being prayed for, blessed, and deeply loved.</p>
          </div>
          ${weekHTML || `<p class="center muted">Your book will fill up as you write. Start with this week's Pause + Reflect.</p>`}
          ${birthHTML}
        </div>
      </div>`, "legacy");
    qs("#print").addEventListener("click", () => window.print());
    window.scrollTo({ top: 0 });
  }

  function viewAccount() {
    const p = state.profile;
    app.innerHTML = shell(`
      <div class="wrap">
        <div class="reading"><h1><span class="script-soft">Your journal</span></h1></div>
        <form class="paper" id="profile-form">
          <div class="field"><label for="first">Your first name</label><input id="first" autocomplete="given-name" value="${esc(p.first_name || "")}"></div>
          <div class="field"><label for="nick">What you call your baby</label><input id="nick" placeholder="A name, a nickname, or just 'little one'" value="${esc(p.baby_nickname || "")}"></div>
          <div class="field"><label for="due2">Due date</label><input type="date" id="due2" value="${esc(p.due_date || "")}"></div>
          <button class="btn" type="submit">Save</button>
        </form>
        <div class="paper stack">
          <p style="margin:0">Signed in as <strong>${esc((state.user && state.user.email) || "")}</strong></p>
          <p class="form-note" style="margin:0">Your words and photos are private to you. When you tap Speak, your browser's built-in speech service turns your voice into text; this journal never stores any audio.</p>
          <p class="form-note" style="margin:0">Questions or something not working? Email <a href="mailto:${esc(CFG.supportEmail)}">${esc(CFG.supportEmail)}</a>.</p>
          <button class="btn ghost" id="signout2">Sign out</button>
        </div>
      </div>
      ${footer()}`, "account");
    qs("#profile-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const upd = { first_name: qs("#first").value.trim() || null, baby_nickname: qs("#nick").value.trim() || null, due_date: qs("#due2").value || null };
      try { await store.saveProfile(upd); Object.assign(state.profile, upd); toast("Saved."); } catch (_) { toast("That didn't save. Try again?"); }
    });
    qs("#signout2").addEventListener("click", async () => {
      if (!store.live && !confirm("Preview mode: signing out clears everything saved in this browser. Continue?")) return;
      await store.signOut();
      state.user = null;
      location.hash = "#/";
      location.reload();
    });
  }

  /* ------------------------------------------------------------ router */
  async function route() {
    if (!state.user) return viewSignIn();
    if (!state.isMember) return viewNotMember();
    flushSaves();
    if (activeDictation) activeDictation();
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    try {
      if (parts[0] === "week") return await viewWeek(parts[1], parts[2]);
      if (parts[0] === "page") return await viewPage(parts[1]);
      if (parts[0] === "birth") return await viewBirth();
      if (parts[0] === "legacy") return await viewLegacy();
      if (parts[0] === "account") return viewAccount();
      return await viewHome();
    } catch (err) {
      console.error(err);
      app.innerHTML = shell(`<div class="wrap"><div class="paper"><p>Something went wrong loading this page. Please refresh. If it keeps happening, email <a href="mailto:${esc(CFG.supportEmail)}">${esc(CFG.supportEmail)}</a>.</p></div></div>`, "");
    }
  }

  async function afterSignIn() {
    viewLoading();
    try {
      state.isMember = await store.isMember();
      if (state.isMember) state.profile = await store.getProfile();
    } catch (err) {
      console.error(err);
      state.isMember = false;
    }
    route();
  }

  async function boot() {
    if (LIVE) {
      store = makeLiveStore();
    } else {
      await loadDemoContent();
      store = makeDemoStore();
    }
    viewLoading("Opening your journal…");
    state.user = await store.session();
    if (state.user) await afterSignIn(); else viewSignIn();
    store.onAuth((u) => { if (!u && state.user) { state.user = null; viewSignIn(); } });
    window.addEventListener("hashchange", route);
  }

  boot();
})();
