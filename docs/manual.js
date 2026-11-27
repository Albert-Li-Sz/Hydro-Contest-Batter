// Hydro Contest Better manual: theme switch, sidebar scrollspy, "on this page" outline,
// heading anchors, copy buttons for code blocks and the mobile sidebar drawer.
(() => {
  const root = document.documentElement;
  const store = {
    get() { try { return localStorage.getItem('hcb-theme'); } catch { return null; } },
    set(value) { try { localStorage.setItem('hcb-theme', value); } catch { /* private mode */ } },
  };
  const systemDark = matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : systemDark.matches;

  const themeButton = document.querySelector('.theme-toggle');
  const syncThemeLabel = () => {
    if (!themeButton) return;
    const label = isDark() ? '切换到浅色模式' : '切换到深色模式';
    themeButton.setAttribute('aria-label', label);
    themeButton.title = label;
  };
  themeButton?.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    root.dataset.theme = next;
    store.set(next);
    syncThemeLabel();
  });
  systemDark.addEventListener('change', syncThemeLabel);
  syncThemeLabel();

  // Mobile drawer.
  const body = document.body;
  const menuButton = document.querySelector('.menu-toggle');
  const setMenu = (open) => {
    body.classList.toggle('nav-open', open);
    menuButton?.setAttribute('aria-expanded', String(open));
  };
  menuButton?.addEventListener('click', () => setMenu(!body.classList.contains('nav-open')));
  document.querySelector('.backdrop')?.addEventListener('click', () => setMenu(false));
  document.querySelectorAll('.sidebar a').forEach((link) => link.addEventListener('click', () => setMenu(false)));
  addEventListener('keydown', (event) => { if (event.key === 'Escape') setMenu(false); });

  const main = document.querySelector('main');
  if (!main) return;

  // Heading anchors: a section's h2 links to the section, an h3 to itself.
  const slug = (text) => text.trim().toLowerCase().replace(/[\s·、，,。.:：/（）()「」"'?？!！]+/g, '-').replace(/^-+|-+$/g, '');
  const used = new Set([...document.querySelectorAll('[id]')].map((node) => node.id));
  main.querySelectorAll('section h2, section h3').forEach((heading) => {
    let id = heading.tagName === 'H2' ? heading.closest('section')?.id : heading.id;
    if (!id) {
      const base = slug(heading.textContent) || 'section';
      id = base;
      for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
      heading.id = id;
      used.add(id);
    }
    const anchor = document.createElement('a');
    anchor.className = 'header-anchor';
    anchor.href = `#${id}`;
    anchor.setAttribute('aria-label', `链接到「${heading.textContent.trim()}」`);
    anchor.textContent = '#';
    heading.prepend(anchor);
  });

  // Copy buttons.
  const copyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  main.querySelectorAll('pre').forEach((pre) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    button.setAttribute('aria-label', '复制代码');
    button.innerHTML = copyIcon;
    button.addEventListener('click', async () => {
      const text = pre.querySelector('code')?.innerText ?? pre.innerText;
      try {
        await navigator.clipboard.writeText(text.replace(/\n$/, ''));
        button.classList.add('copied');
        setTimeout(() => button.classList.remove('copied'), 1600);
      } catch { /* clipboard unavailable: the text stays selectable */ }
    });
    pre.append(button);
  });

  // Scrollspy: the sidebar entry and the "on this page" outline follow the reader.
  const sidebarLinks = [...document.querySelectorAll('.sidebar a[href^="#"]')];
  const targets = sidebarLinks.map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1)))).filter(Boolean);
  const outline = document.querySelector('.outline');
  const outlineList = outline?.querySelector('nav');
  let outlineSection = null;

  const renderOutline = (section) => {
    if (!outline || !outlineList || section === outlineSection) return;
    outlineSection = section;
    const headings = section ? [...section.querySelectorAll('h3[id]')] : [];
    outline.hidden = headings.length < 2;
    outlineList.replaceChildren(...headings.map((heading) => {
      const link = document.createElement('a');
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent.replace(/^#/, '').trim();
      return link;
    }));
  };

  const offset = () => parseFloat(getComputedStyle(root).scrollPaddingTop) || 84;
  const update = () => {
    const line = offset() + 8;
    let current = targets[0] || null;
    for (const target of targets) if (target.getBoundingClientRect().top <= line) current = target;
    if (innerHeight + scrollY >= document.body.scrollHeight - 2 && targets.length) current = targets[targets.length - 1];
    sidebarLinks.forEach((link) => {
      const on = current && link.hash === `#${current.id}`;
      link.classList.toggle('active', !!on);
      if (on) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
    });
    const section = current?.closest('section') ?? null;
    renderOutline(section);
    if (outlineList) {
      let active = null;
      for (const link of outlineList.querySelectorAll('a')) {
        const heading = document.getElementById(link.hash.slice(1));
        if (heading && heading.getBoundingClientRect().top <= line) active = link;
      }
      outlineList.querySelectorAll('a').forEach((link) => link.classList.toggle('active', link === active));
    }
  };
  let queued = false;
  addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  }, { passive: true });
  addEventListener('resize', update);
  update();
})();
