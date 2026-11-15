'use strict';

const fs = require('fs');
const path = require('path');
const { getCategoryLabels } = require('./catalog');
const { extractProjectIdFromUrl } = require('./state');

const MAX_DIALOG_LENGTH = 120;

function stripIconLigature(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[a-z][a-z0-9_]*)\s+/, '');
}

async function detectAuthAndPageState(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');

  const snapshot = await page.evaluate(() => {
    const bodyText = (document.body && document.body.innerText) || '';
    const isGoogleAccounts = /accounts\.google\.com/i.test(window.location.href);

    const signInBtn = Array.from(document.querySelectorAll('a, button')).find((el) => {
      const txt = (el.innerText || el.getAttribute('aria-label') || '').trim();
      return /^(sign in|log in|masuk|login|get started|mulai)$/i.test(txt);
    });

    const hasFlowProjectUrl = /\/project\/[a-zA-Z0-9_-]+/i.test(window.location.pathname);
    const hasPromptComposer = Boolean(
      document.querySelector(
        'div.ProseMirror[role="textbox"], [aria-label*="Apa yang ingin Anda buat" i], [aria-label*="What would you like to create" i], textarea, [contenteditable="true"], [role="textbox"]'
      )
    );
    const hasVoiceOrAssetNav = /Project baru|Proyek baru|New project|Telusuri aset|Search assets|Contoh dialog|Sample dialog|Tambahkan ke perintah|Add to prompt/i.test(
      bodyText
    );

    const editableTitleEl = document.querySelector(
      'input.editable-text-input[aria-label*="Teks yang dapat diedit" i], input.editable-text-input'
    );
    const projectHeadingEl =
      document.querySelector('header h1, header [role="button"], [data-testid*="project-title"]') ||
      document.querySelector('h1');
    const titleFromDoc = (document.title || '').replace(/^Google Flow\s*-\s*/i, '').trim();
    const headingText =
      (editableTitleEl && editableTitleEl.value && editableTitleEl.value.trim()) ||
      (hasFlowProjectUrl && titleFromDoc && titleFromDoc !== document.title ? titleFromDoc : '') ||
      (projectHeadingEl ? (projectHeadingEl.innerText || '').trim() : '');

    return {
      isGoogleAccounts,
      hasSignInPrompt: Boolean(signInBtn),
      signInLabel: signInBtn ? (signInBtn.innerText || '').trim() : null,
      hasFlowProjectUrl,
      hasPromptComposer,
      hasVoiceOrAssetNav,
      headingText,
    };
  });

  const authenticated =
    !snapshot.isGoogleAccounts &&
    (snapshot.hasFlowProjectUrl || snapshot.hasVoiceOrAssetNav || snapshot.hasPromptComposer || !snapshot.hasSignInPrompt);

  return {
    url,
    title,
    projectId: extractProjectIdFromUrl(url),
    authenticated,
    needsLogin: snapshot.isGoogleAccounts || (snapshot.hasSignInPrompt && !snapshot.hasFlowProjectUrl),
    inProject: snapshot.hasFlowProjectUrl,
    hasPromptComposer: snapshot.hasPromptComposer,
    headingText: snapshot.headingText,
    signInLabel: snapshot.signInLabel,
  };
}

async function readComposerState(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const composer = document.querySelector(
      'div.ProseMirror[role="textbox"], [aria-label*="Apa yang ingin Anda buat" i][role="textbox"], [aria-label*="What would you like to create" i][role="textbox"]'
    );
    const promptText = composer ? clean(composer.innerText) : '';

    const bar = document.querySelector('flow-ingredient-bar, .prompt-ingredient-bar');
    const chipRoot = bar || document;
    const rawChips = Array.from(chipRoot.querySelectorAll('flow-ingredient-chip'));
    const fallbackButtons = rawChips.length
      ? []
      : Array.from(chipRoot.querySelectorAll('button.chip-container, button[aria-label="Bahan"]'));

    const chipEls = rawChips.length ? rawChips : fallbackButtons;
    const ingredientChips = chipEls.map((el, index) => {
      const btn = el.matches('button')
        ? el
        : el.querySelector('button.chip-container, button[aria-label="Bahan"], button');
      const text = clean(el.innerText);
      const ariaLabel = (btn && btn.getAttribute('aria-label')) || el.getAttribute('aria-label') || null;
      const img = el.querySelector('img');
      const hasError = Boolean(
        el.classList.contains('error') ||
          (btn && (btn.classList.contains('disabled') || btn.classList.contains('error'))) ||
          el.querySelector('.disabled-error-icon') ||
          /\berror\b/i.test(text)
      );
      const kind = el.querySelector('flow-audio-ingredient-chip')
        ? 'audio'
        : img
          ? 'image'
          : 'ingredient';
      return {
        index,
        kind,
        text,
        ariaLabel,
        hasError,
        imgAlt: img ? img.getAttribute('alt') || null : null,
      };
    });

    const settingsBtn = document.querySelector(
      'button.settings-trigger-button, button[aria-label*="Pemicu setelan" i], button[aria-label*="Settings trigger" i]'
    );
    const settingsSummary = settingsBtn ? clean(settingsBtn.innerText) : null;

    const genBtn = document.querySelector(
      'button.generate-icon-button, button[aria-label*="Mulai pembuatan" i], button[aria-label*="Start generation" i]'
    );
    const generateButtonDisabled = genBtn
      ? Boolean(genBtn.disabled || genBtn.getAttribute('aria-disabled') === 'true')
      : true;

    const generateReady = Boolean(
      promptText.length > 0 && !generateButtonDisabled && ingredientChips.every((c) => !c.hasError)
    );

    return {
      promptText,
      ingredientChips,
      settingsSummary,
      generateButtonDisabled,
      generateReady,
    };
  });
}

async function inspectPageDom(page) {
  const composerState = await readComposerState(page);
  const dom = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const buttons = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"]'))
      .filter(isVisible)
      .slice(0, 60)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || null,
        text: clean(el.innerText).slice(0, 120),
        ariaLabel: el.getAttribute('aria-label') || null,
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      }));

    const inputs = Array.from(
      document.querySelectorAll('textarea, input:not([type="hidden"]), [contenteditable="true"], [role="textbox"]')
    )
      .filter(isVisible)
      .slice(0, 30)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || null,
        placeholder: el.getAttribute('placeholder') || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        name: el.getAttribute('name') || null,
        maxLength: el.getAttribute('maxlength') || null,
        valuePreview: clean(el.value !== undefined ? el.value : el.innerText).slice(0, 120),
      }));

    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map((el) => ({
      accept: el.getAttribute('accept') || null,
      multiple: el.hasAttribute('multiple'),
      ariaLabel: el.getAttribute('aria-label') || null,
    }));

    const projectLinks = Array.from(document.querySelectorAll('a[href*="/project/"], a[href*="/projects/"]'))
      .slice(0, 40)
      .map((a) => ({
        href: a.href,
        text: clean(a.innerText).slice(0, 120),
      }));

    return {
      url: window.location.href,
      title: document.title,
      buttons,
      inputs,
      fileInputs,
      projectLinks,
    };
  });

  return {
    ...dom,
    composerState,
  };
}

async function listProjectsFromUi(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const seen = new Map();

    const cards = Array.from(document.querySelectorAll('.project-card'));
    for (const card of cards) {
      const link = card.querySelector('a.project-thumbnail-container[href*="/project/"], a[href*="/project/"]');
      if (!link) continue;
      const href = link.href;
      const m = href.match(/\/projects?\/([a-zA-Z0-9_-]+)/i);
      if (!m) continue;
      const id = m[1];
      const titleEl = card.querySelector('.project-title-text');
      const title = clean(titleEl ? titleEl.innerText : link.innerText) || id;
      if (!seen.has(id)) {
        seen.set(id, {
          projectId: id,
          title,
          webUrl: href,
          source: 'dom',
        });
      }
    }

    const links = Array.from(document.querySelectorAll('a[href*="/project/"], a[href*="/projects/"]'));
    for (const a of links) {
      const href = a.href;
      const m = href.match(/\/projects?\/([a-zA-Z0-9_-]+)/i);
      if (!m) continue;
      const id = m[1];
      if (!seen.has(id)) {
        seen.set(id, {
          projectId: id,
          title: clean(a.innerText) || id,
          webUrl: href,
          source: 'dom',
        });
      }
    }
    return Array.from(seen.values());
  });
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function clickFirstMatchingElement(
  page,
  patterns,
  selectorList = ['button', '[role="button"]', '[role="tab"]', 'mat-list-item', 'a'],
  rootSelector = null
) {
  const regexList = patterns.map((p) => (p instanceof RegExp ? p.source : escapeRegExp(p)));
  const clicked = await page.evaluate(
    ({ regexSources, selectors, rootSel }) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const stripLigature = (s) => clean(s).replace(/^(?:[a-z][a-z0-9_]*)\s+/, '');
      const compiled = regexSources.map((src) => new RegExp(src, 'i'));
      const root = (rootSel && document.querySelector(rootSel)) || document;
      const candidates = Array.from(root.querySelectorAll(selectors.join(',')));

      const visible = candidates.filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });

      for (const rx of compiled) {
        const match = visible.find((el) => {
          const text = clean(el.innerText);
          const stripped = stripLigature(text);
          const aria = clean(el.getAttribute('aria-label'));
          const title = clean(el.getAttribute('title'));
          return rx.test(text) || rx.test(stripped) || rx.test(aria) || rx.test(title);
        });
        if (match) {
          match.scrollIntoView({ block: 'center', inline: 'center' });
          match.click();
          return {
            matched: true,
            text: stripLigature(match.innerText || match.getAttribute('aria-label') || ''),
          };
        }
      }
      return { matched: false };
    },
    { regexSources: regexList, selectors: selectorList, rootSel: rootSelector }
  );
  return clicked;
}

async function createNewProjectInUi(page, title) {
  const beforeUrl = page.url();
  const createPatterns = [
    /^Project baru$/i,
    /^Proyek baru$/i,
    /^New project$/i,
    /Project baru|Proyek baru|New project|Buat proyek|Create project/i,
  ];

  const clicked = await clickFirstMatchingElement(page, createPatterns, ['button', '[role="button"]', 'a']);
  if (!clicked.matched) {
    throw new Error(
      'Could not find a "Project baru" / "New project" button on the current Flow page. Run `flow-canvas project inspect` to check the live UI.'
    );
  }

  try {
    await page.waitForFunction(
      (prev) => window.location.href !== prev && /\/projects?\//i.test(window.location.href),
      beforeUrl,
      { timeout: 15000 }
    );
  } catch {
    await page.waitForTimeout(1500);
  }

  if (title) {
    await tryRenameCurrentProject(page, title).catch(() => false);
  }

  const webUrl = page.url();
  const projectId = extractProjectIdFromUrl(webUrl) || `project_${Date.now()}`;
  return {
    projectId,
    title: title || 'New Flow Project',
    webUrl,
    clickedLabel: clicked.text,
  };
}

async function tryRenameCurrentProject(page, title) {
  if (!title) return false;
  const titleInput = page
    .locator(
      'input.editable-text-input[aria-label*="Teks yang dapat diedit" i], input.editable-text-input, input[aria-label*="project" i], input[aria-label*="proyek" i]'
    )
    .first();

  if (await titleInput.count()) {
    await titleInput.click();
    await titleInput.fill(title);
    await titleInput.press('Enter');
    await page.waitForTimeout(300);
    return true;
  }
  return false;
}

async function isAssetDrawerOpen(page) {
  return page
    .locator('.cdk-overlay-container .side-nav-list-item, .cdk-overlay-container input.search-input')
    .first()
    .isVisible()
    .catch(() => false);
}

async function waitForDrawerOpen(page, timeoutMs = 2500) {
  await page
    .locator('.cdk-overlay-container .side-nav-list-item[role="tab"], .cdk-overlay-container button.asset-item[role="option"]')
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .catch(() => {});
  return isAssetDrawerOpen(page);
}

async function waitForDrawerClosed(page, timeoutMs = 450) {
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector('.cdk-overlay-container .side-nav-list-item, .cdk-overlay-container input.search-input');
        if (!el) return true;
        const r = el.getBoundingClientRect();
        return r.width === 0 || r.height === 0;
      },
      null,
      { timeout: timeoutMs, polling: 40 }
    )
    .catch(() => {});
  return !(await isAssetDrawerOpen(page));
}

async function ensureAssetDrawerOpen(page) {
  if (await isAssetDrawerOpen(page)) return true;

  const opener = page
    .locator(
      'button[aria-label*="Tambahkan bahan ke kotak perintah" i], button[aria-label*="Tambahkan bahan" i], button[aria-label*="Add ingredient" i], button[aria-label*="Add to prompt" i]'
    )
    .first();

  if (await opener.count()) {
    await opener.click();
    if (await waitForDrawerOpen(page, 2500)) return true;
  }

  const res = await clickFirstMatchingElement(page, [
    /Tambahkan bahan/i,
    /Add ingredients|Add media|Add asset/i,
    /Suara|Voice/i,
  ]);
  if (res.matched) {
    return await waitForDrawerOpen(page, 2500);
  }
  return await isAssetDrawerOpen(page);
}

async function closeAssetDrawerIfOpen(page) {
  if (!(await isAssetDrawerOpen(page))) return false;
  await page.keyboard.press('Escape').catch(() => {});
  if (await waitForDrawerClosed(page, 350)) return true;
  const closeBtn = page
    .locator('button[aria-label*="Tambahkan bahan ke kotak perintah" i]')
    .first();
  if (await closeBtn.count()) {
    await closeBtn.click({ force: true }).catch(() => {});
    await waitForDrawerClosed(page, 350);
  }
  return !(await isAssetDrawerOpen(page));
}

async function openAssetTab(page, categoryKey) {
  await ensureAssetDrawerOpen(page);
  const labels = getCategoryLabels(categoryKey);
  const patterns = labels.map((l) => escapeRegExp(l).replace(/\\\.\.\./g, '.*'));

  const tabResult = await page.evaluate(
    ({ rawPatterns }) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const stripLigature = (s) => clean(s).replace(/^(?:[a-z][a-z0-9_]*)\s+/, '');
      const root = document.querySelector('.cdk-overlay-container') || document;
      const tabs = Array.from(
        root.querySelectorAll('mat-list-item.side-nav-list-item[role="tab"], [role="tab"]')
      ).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      const exactRx = rawPatterns.map((p) => new RegExp(`^${p}$`, 'i'));
      const partialRx = rawPatterns.map((p) => new RegExp(p, 'i'));

      let match = null;
      for (const rxList of [exactRx, partialRx]) {
        for (const rx of rxList) {
          match = tabs.find((el) => {
            const text = clean(el.innerText);
            const stripped = stripLigature(text);
            const aria = clean(el.getAttribute('aria-label'));
            return rx.test(text) || rx.test(stripped) || rx.test(aria);
          });
          if (match) break;
        }
        if (match) break;
      }

      if (!match) return { matched: false };

      const alreadyActive =
        match.getAttribute('aria-selected') === 'true' ||
        match.classList.contains('mdc-list-item--activated') ||
        match.classList.contains('active') ||
        match.classList.contains('side-nav-list-item-active');

      if (!alreadyActive) {
        match.scrollIntoView({ block: 'center', inline: 'center' });
        match.click();
      }
      return {
        matched: true,
        alreadyActive,
        text: stripLigature(match.innerText || match.getAttribute('aria-label') || ''),
      };
    },
    { rawPatterns: patterns }
  );

  if (tabResult.matched && !tabResult.alreadyActive) {
    await page.waitForTimeout(80);
  }
  return tabResult;
}

async function searchAssetsInDrawer(page, query) {
  const searchBox = page
    .locator(
      '.cdk-overlay-container input.search-input, input[placeholder*="Telusuri aset" i], input[placeholder*="Search assets" i]'
    )
    .first();
  if (!(await searchBox.count())) {
    return false;
  }
  await searchBox.click();
  await searchBox.fill(query || '');
  await page.waitForTimeout(400);
  return true;
}

async function readVisibleAssets(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const stripLigature = (s) => clean(s).replace(/^(?:[a-z][a-z0-9_]*)\s+/, '');
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const root = document.querySelector('.cdk-overlay-container') || document;
    const items = [];
    const seen = new Set();

    const cards = Array.from(
      root.querySelectorAll('button.asset-item[role="option"], [role="option"], [role="listitem"], [data-testid*="asset"], [role="gridcell"]')
    ).filter(isVisible);

    cards.forEach((el, idx) => {
      const rawText = clean(el.innerText);
      const ariaLabel = clean(el.getAttribute('aria-label') || '');
      const img = el.querySelector('img');
      const imgAlt = img ? clean(img.getAttribute('alt') || '') : '';
      const imgSrc = img ? (img.getAttribute('src') || '').slice(0, 140) : '';
      const label = stripLigature(rawText) || stripLigature(ariaLabel) || imgAlt || (img ? `[image #${idx}]` : '');
      if (!label) return;
      const dedupeKey = `${label}::${ariaLabel}::${imgSrc || idx}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      items.push({
        index: idx,
        label: label.slice(0, 140),
        rawText: rawText.slice(0, 140),
        ariaLabel: ariaLabel || null,
        imgAlt: imgAlt || null,
        hasImage: Boolean(img),
        imgSrc: imgSrc || null,
        active: el.classList.contains('asset-item-active') || el.getAttribute('aria-selected') === 'true',
      });
    });

    return items.slice(0, 80);
  });
}

async function waitForUploadSettlement(page, beforeCount, expectedNewCount = 1, timeoutMs = 60000) {
  const startedAt = Date.now();
  const targetCount = beforeCount + Math.max(1, expectedNewCount);

  while (Date.now() - startedAt < timeoutMs) {
    const probe = await page.evaluate(() => {
      const root = document.querySelector('.cdk-overlay-container') || document;
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const cards = Array.from(root.querySelectorAll('button.asset-item[role="option"]')).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const uploadingCount = cards.filter((el) => /\b(?:Mengupload|Uploading)\b/i.test(clean(el.innerText))).length;
      const spinners = Array.from(
        root.querySelectorAll('mat-spinner, mat-progress-spinner, [role="progressbar"], .uploading, .upload-progress')
      ).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const dialogButtons = Array.from(
        document.querySelectorAll('.cdk-overlay-container button, [role="dialog"] button')
      )
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((el) => clean(el.innerText || el.getAttribute('aria-label') || ''))
        .filter(Boolean);

      return {
        cardCount: cards.length,
        uploadingCount,
        spinnerCount: spinners.length,
        dialogButtons: dialogButtons.slice(0, 20),
      };
    });

    if (probe.spinnerCount === 0 && probe.uploadingCount === 0 && probe.cardCount >= targetCount) {
      return probe;
    }
    await page.waitForTimeout(120);
  }

  return await page.evaluate(() => {
    const root = document.querySelector('.cdk-overlay-container') || document;
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const cards = Array.from(root.querySelectorAll('button.asset-item[role="option"]')).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const uploadingCount = cards.filter((el) => /\b(?:Mengupload|Uploading)\b/i.test(clean(el.innerText))).length;
    const dialogButtons = Array.from(
      document.querySelectorAll('.cdk-overlay-container button, [role="dialog"] button')
    )
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((el) => clean(el.innerText || el.getAttribute('aria-label') || ''))
      .filter(Boolean);
    return {
      cardCount: cards.length,
      uploadingCount,
      spinnerCount: 0,
      dialogButtons: dialogButtons.slice(0, 20),
      timedOut: true,
    };
  });
}

async function attachDrawerCard(page, { query = null, index = null, categoryKey = 'uploaded' } = {}) {
  await openAssetTab(page, categoryKey);

  const selectCard = () =>
    page.evaluate(
      ({ q, idx }) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const stripLigature = (s) => clean(s).replace(/^(?:[a-z][a-z0-9_]*)\s+/, '');
        const root = document.querySelector('.cdk-overlay-container') || document;
        const cards = Array.from(root.querySelectorAll('button.asset-item[role="option"]')).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });

        let card = null;
        let matchedIdx = -1;
        if (q) {
          const needle = String(q).trim().toLowerCase();
          matchedIdx = cards.findIndex((el) => {
            const raw = clean(el.innerText);
            const stripped = stripLigature(raw);
            const aria = clean(el.getAttribute('aria-label') || '');
            const alt = clean(el.querySelector('img')?.getAttribute('alt') || '');
            return [raw, stripped, aria, alt].some((s) => s && s.toLowerCase().includes(needle));
          });
          if (matchedIdx !== -1) card = cards[matchedIdx];
        } else if (typeof idx === 'number' && idx >= 0 && idx < cards.length) {
          matchedIdx = idx;
          card = cards[idx];
        }

        if (!card) return { found: false, totalCards: cards.length };

        card.scrollIntoView({ block: 'center' });
        const wasAlreadyActive =
          card.classList.contains('asset-item-active') || card.getAttribute('aria-selected') === 'true';
        const label =
          stripLigature(card.innerText) ||
          clean(card.getAttribute('aria-label') || '') ||
          clean(card.querySelector('img')?.getAttribute('alt') || '') ||
          `card-${matchedIdx}`;
        card.click();
        return { found: true, index: matchedIdx, label: label.slice(0, 140), wasAlreadyActive };
      },
      { q: query, idx: index }
    );

  // Ensure any leftover filter in Telusuri aset doesn't hide cards
  const searchBox = page
    .locator('.cdk-overlay-container input.search-input, input[placeholder*="Telusuri aset" i], input[placeholder*="Search assets" i]')
    .first();
  if (await searchBox.count()) {
    const existing = await searchBox.inputValue().catch(() => '');
    if (existing) {
      await searchBox.fill('');
      await page.waitForTimeout(80);
    }
  }

  let clicked = await selectCard();
  if (!clicked.found && query) {
    await searchAssetsInDrawer(page, query);
    clicked = await selectCard();
    if (!clicked.found && (await searchBox.count())) {
      await searchBox.fill('');
      await page.waitForTimeout(60);
    }
  }

  if (!clicked.found) {
    return {
      found: false,
      attached: false,
      reason: query ? `Asset matching "${query}" not found` : `Card index ${index} not found`,
    };
  }

  if (clicked.wasAlreadyActive) {
    if (await waitForDrawerClosed(page, 400)) {
      return { attached: true, method: 'active-card-click', ...clicked };
    }
  } else {
    // Allow Angular detail panel a brief frame to bind to the newly selected card before clicking Add
    await page.waitForTimeout(80);
    if (!(await isAssetDrawerOpen(page))) {
      return { attached: true, method: 'active-card-click', ...clicked };
    }
  }

  const addBtn = page
    .locator(
      '.cdk-overlay-container button.detail-add-to-prompt-btn:not([disabled]), button.detail-add-to-prompt-btn:not([disabled])'
    )
    .first();
  await addBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  if (await addBtn.count() && await addBtn.isEnabled().catch(() => false)) {
    const addButtonLabel = stripIconLigature(await addBtn.innerText().catch(() => 'Tambahkan ke perintah'));
    await addBtn.click();
    await waitForDrawerClosed(page, 400);
    return { attached: true, method: 'detail-add-to-prompt-btn', addButtonLabel, ...clicked };
  }

  const addClicked = await clickFirstMatchingElement(
    page,
    [/^Tambahkan ke perintah$/i, /^Add to prompt$/i, /Use as reference/i],
    ['button:not([disabled])', '[role="button"]:not([aria-disabled="true"])'],
    '.cdk-overlay-container'
  );
  if (addClicked.matched) {
    await waitForDrawerClosed(page, 400);
  }
  return {
    attached: addClicked.matched || !(await isAssetDrawerOpen(page)),
    method: addClicked.matched ? 'fallback-add-button' : 'card-click-only',
    addButtonLabel: addClicked.text || null,
    ...clicked,
  };
}

async function uploadFilesInUi(
  page,
  filePaths,
  categoryKey = 'uploaded',
  { attachUploaded = false, skipExisting = true } = {}
) {
  const resolved = filePaths.map((fp) => path.resolve(fp));
  for (const fp of resolved) {
    if (!fs.existsSync(fp)) {
      throw new Error(`Upload file not found: ${fp}`);
    }
  }

  await openAssetTab(page, categoryKey);
  const beforeAssets = await readVisibleAssets(page);
  const beforeKeys = new Set(beforeAssets.map((a) => `${a.label}::${a.ariaLabel || ''}::${a.imgSrc || ''}`));
  const existingTexts = beforeAssets
    .filter((a) => !/\b(?:Mengupload|Uploading)\b/i.test(a.label))
    .map((a) => `${a.label} ${a.rawText}`.toLowerCase());

  const filesToUpload = skipExisting
    ? resolved.filter((fp) => {
        const base = path.basename(fp).toLowerCase();
        return !existingTexts.some((txt) => txt.includes(base));
      })
    : resolved;

  let method = filesToUpload.length === 0 ? 'skipped-existing' : null;
  let clickedLabel = null;
  let settleProbe = null;
  let afterAssets = beforeAssets;

  if (filesToUpload.length > 0) {
    const uploadBtn = page
      .locator('.cdk-overlay-container button.sidebar-upload-btn, button.sidebar-upload-btn')
      .first();

    if (await uploadBtn.count()) {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
      await uploadBtn.click();
      const chooser = await chooserPromise;
      if (chooser) {
        await chooser.setFiles(filesToUpload);
        method = 'sidebar-upload-btn-filechooser';
      }
    }

    if (!method) {
      const fileInput = page.locator('input[type="file"]').first();
      if (await fileInput.count()) {
        await fileInput.setInputFiles(filesToUpload);
        method = 'input[type="file"]';
      }
    }

    if (!method) {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
      const clicked = await clickFirstMatchingElement(
        page,
        [/Upload media/i, /Unggah|Upload/i, /Tambahkan file|Add file/i],
        ['button', '[role="button"]'],
        '.cdk-overlay-container'
      );
      const chooser = await chooserPromise;

      if (chooser) {
        await chooser.setFiles(filesToUpload);
        method = 'filechooser';
        clickedLabel = clicked.text || null;
      }
    }

    if (!method) {
      throw new Error(
        'Could not find the "Upload media" button or file input in the Google Flow asset drawer. Run `flow-canvas project inspect` to check the live UI.'
      );
    }

    settleProbe = await waitForUploadSettlement(page, beforeAssets.length, filesToUpload.length, 60000);
    afterAssets = await readVisibleAssets(page);
  }

  const newLabels = [];
  afterAssets.forEach((asset) => {
    const key = `${asset.label}::${asset.ariaLabel || ''}::${asset.imgSrc || ''}`;
    if (!beforeKeys.has(key)) {
      newLabels.push(asset.label);
    }
  });

  // Match by exact uploaded filename so attaching doesn't drift as Google Flow removes attached items from the picker
  const attachTargets = resolved.map((fp, i) => path.basename(fp) || newLabels[i] || null).filter(Boolean);

  const attached = [];
  if (attachUploaded && attachTargets.length > 0) {
    for (const targetQuery of attachTargets) {
      let att = await attachDrawerCard(page, { query: targetQuery, categoryKey });
      if (!att.attached) {
        att = await attachDrawerCard(page, { index: 0, categoryKey });
      }
      attached.push(att);
    }
    await closeAssetDrawerIfOpen(page);
  }

  return {
    method,
    clickedLabel,
    uploaded: resolved,
    newlyUploaded: filesToUpload,
    skippedExisting: resolved.filter((fp) => !filesToUpload.includes(fp)),
    beforeCount: beforeAssets.length,
    afterCount: afterAssets.length,
    settleProbe,
    afterAssets,
    attached,
  };
}

async function attachAssetInUi(page, query, categoryKey = 'semua') {
  const res = await attachDrawerCard(page, { query, categoryKey });
  if (!res.found) {
    throw new Error(`Asset matching "${query}" was not found in category "${categoryKey}".`);
  }
  await closeAssetDrawerIfOpen(page);
  return {
    assetMatched: res.label,
    addedToPrompt: res.attached,
    method: res.method,
    addButtonLabel: res.addButtonLabel || null,
  };
}

async function fillControlledField(locator, value) {
  await locator.click();
  await locator.fill('');
  await locator.fill(value);
  await locator.evaluate((el, val) => {
    if ('value' in el) {
      el.value = val;
    } else {
      el.textContent = val;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function configureVoiceInUi(page, { voiceName, dialog, style, saveName = '', preview = false }) {
  const tabRes = await openAssetTab(page, 'suara');
  await page.waitForTimeout(450);

  // Google Flow's "Telusuri aset" search box does not match built-in voices and shows "Aset tidak ditemukan."
  const searchBox = page
    .locator('.cdk-overlay-container input.search-input, input[placeholder*="Telusuri aset" i], input[placeholder*="Search assets" i]')
    .first();
  if (await searchBox.count()) {
    const currentSearch = await searchBox.inputValue().catch(() => '');
    if (currentSearch) {
      await searchBox.fill('');
      await page.waitForTimeout(450);
    }
  }

  if (voiceName) {
    let voiceClicked = { matched: false };

    const tryMatchVoice = () =>
      page.evaluate((target) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const stripLigature = (s) => clean(s).replace(/^(?:[a-z][a-z0-9_]*\s+){1,2}/, '');
        const needle = String(target).trim().toLowerCase();
        const root = document.querySelector('.cdk-overlay-container') || document;
        const els = Array.from(root.querySelectorAll('button.asset-item[role="option"]'));
        const visible = els.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 20 && r.height > 20;
        });

        const exactLine = visible.find((el) => {
          const raw = stripLigature(el.innerText);
          const lines = (el.innerText || '')
            .split('\n')
            .map((l) => stripLigature(l).toLowerCase())
            .filter(Boolean);
          return lines.includes(needle) || raw.toLowerCase() === needle;
        });

        const exactWord =
          exactLine ||
          visible.find((el) => {
            const raw = stripLigature(el.innerText);
            const firstWord = raw.split(/\s+/)[0]?.toLowerCase() || '';
            return firstWord === needle;
          });

        const fallback =
          exactWord ||
          visible.find((el) => {
            const txt = stripLigature(el.innerText).toLowerCase();
            return txt.startsWith(needle);
          });

        if (fallback) {
          fallback.scrollIntoView({ block: 'center' });
          const isAlreadyActive =
            fallback.classList.contains('asset-item-active') || fallback.getAttribute('aria-selected') === 'true';
          if (!isAlreadyActive) {
            fallback.click();
          }
          return {
            matched: true,
            alreadyActive: isAlreadyActive,
            label: stripLigature(fallback.innerText).slice(0, 120),
          };
        }
        return { matched: false };
      }, voiceName);

    voiceClicked = await tryMatchVoice();

    if (!voiceClicked.matched) {
      // Reset scrollable voice list ancestor to top and step through virtualized items if needed
      const scrollMetrics = await page.evaluate(() => {
        const root = document.querySelector('.cdk-overlay-container') || document;
        const opt = root.querySelector('button.asset-item[role="option"]');
        let cur = opt ? opt.parentElement : null;
        while (cur && cur !== root) {
          if (cur.scrollHeight > cur.clientHeight + 10) {
            cur.setAttribute('data-flow-cli-voice-scroller', '1');
            cur.scrollTop = 0;
            return { found: true, scrollHeight: cur.scrollHeight, clientHeight: cur.clientHeight };
          }
          cur = cur.parentElement;
        }
        return { found: false };
      });

      if (scrollMetrics.found) {
        const step = Math.max(120, Math.floor(scrollMetrics.clientHeight * 0.7));
        for (let pos = 0; pos <= scrollMetrics.scrollHeight; pos += step) {
          await page.evaluate((y) => {
            const scroller = document.querySelector('[data-flow-cli-voice-scroller="1"]');
            if (scroller) scroller.scrollTop = y;
          }, pos);
          await page.waitForTimeout(150);
          voiceClicked = await tryMatchVoice();
          if (voiceClicked.matched) break;
        }
      }
    }

    if (!voiceClicked.matched) {
      throw new Error(`Voice "${voiceName}" was not found in the Suara panel.`);
    }
    await page.waitForTimeout(350);
  }

  let appliedDialog = null;
  let dialogTruncated = false;
  if (typeof dialog === 'string' && dialog.length > 0) {
    let text = dialog;
    if (text.length > MAX_DIALOG_LENGTH) {
      text = text.slice(0, MAX_DIALOG_LENGTH);
      dialogTruncated = true;
    }

    const dialogLocator = page
      .locator(
        'textarea.sample-dialogue-input, textarea[placeholder*="memperkenalkan" i], textarea[placeholder*="Contoh" i], textarea[aria-label*="Sample dialog" i]'
      )
      .first();

    if (!(await dialogLocator.count())) {
      throw new Error('Could not locate textarea.sample-dialogue-input ("Contoh dialog") in the Suara panel.');
    }

    await fillControlledField(dialogLocator, text);
    appliedDialog = text;
  }

  let appliedStyle = null;
  if (typeof style === 'string' && style.length > 0) {
    const styleLocator = page
      .locator(
        'textarea.performance-input, textarea[placeholder*="Jelaskan gaya performa" i], textarea[placeholder*="performance" i]'
      )
      .first();

    if (!(await styleLocator.count())) {
      throw new Error('Could not locate textarea.performance-input ("Sesuaikan performa") in the Suara panel.');
    }

    await fillControlledField(styleLocator, style);
    appliedStyle = style;
  }

  let savedCustomVoiceName = null;
  const voiceNameInput = page.locator('.cdk-overlay-container input.voice-name-input, input.voice-name-input').first();
  if (await voiceNameInput.count()) {
    if (saveName && String(saveName).trim()) {
      await fillControlledField(voiceNameInput, String(saveName).trim());
    }
    savedCustomVoiceName = (await voiceNameInput.inputValue().catch(() => '')).trim() || null;
  }

  const saveVoiceBtn = page
    .locator('.cdk-overlay-container button.voice-save-button:not([disabled]), button.voice-save-button:not([disabled])')
    .first();

  if (await saveVoiceBtn.count()) {
    await saveVoiceBtn.click();
    await page
      .locator('.cdk-overlay-container button.detail-add-to-prompt-btn:not([disabled]), button.detail-add-to-prompt-btn:not([disabled])')
      .first()
      .waitFor({ state: 'visible', timeout: 25000 });
    await page.waitForTimeout(250);
  }

  let previewClicked = false;
  if (preview) {
    const previewBtn = page.locator('button.voice-audio-card, button[aria-label*="pratinjau" i], button[aria-label*="preview" i]').first();
    if (await previewBtn.count()) {
      await previewBtn.click();
      previewClicked = true;
      await page.waitForTimeout(400);
    }
  }

  const addBtn = page
    .locator('.cdk-overlay-container button.detail-add-to-prompt-btn, button.detail-add-to-prompt-btn')
    .first();

  let addedToPrompt = false;
  let addButtonLabel = null;
  if (await addBtn.count()) {
    addButtonLabel = stripIconLigature(await addBtn.innerText().catch(() => 'Tambahkan ke perintah'));
    await addBtn.click();
    addedToPrompt = true;
    await page.waitForTimeout(400);
  } else {
    const addRes = await clickFirstMatchingElement(
      page,
      [/^Tambahkan ke perintah$/i, /^Add to prompt$/i],
      ['button', '[role="button"]'],
      '.cdk-overlay-container'
    );
    addedToPrompt = addRes.matched;
    addButtonLabel = addRes.text || null;
  }

  return {
    tabClicked: tabRes.matched,
    voice: voiceName || null,
    savedCustomVoiceName,
    dialog: appliedDialog,
    dialogTruncated,
    style: appliedStyle,
    previewClicked,
    addedToPrompt,
    addButtonLabel,
  };
}

async function selectComposerModeInUi(page, mode) {
  if (!mode) return { switched: false };
  await closeAssetDrawerIfOpen(page);
  const norm = String(mode).trim().toLowerCase();
  const trigger = page.locator('button.settings-trigger-button, button[aria-label*="Pemicu setelan" i]').first();
  if (await trigger.count()) {
    await trigger.click();
    await page.waitForTimeout(350);
    const patterns =
      norm === 'image' || norm === 'gambar'
        ? [/^Gambar$/i, /^Images?$/i, /Image/i]
        : [/^Video$/i, /Video/i];
    const res = await clickFirstMatchingElement(
      page,
      patterns,
      ['button', '[role="radio"]', '[role="tab"]', '[role="menuitem"]', '[role="option"]'],
      '.cdk-overlay-container'
    );
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
    return { switched: res.matched, label: res.text || null, mode: norm };
  }
  return { switched: false, mode: norm };
}

function getComposerLocator(page) {
  return page
    .locator(
      'div.ProseMirror[role="textbox"], [aria-label*="Apa yang ingin Anda buat" i][role="textbox"], [aria-label*="What would you like to create" i][role="textbox"]'
    )
    .first();
}

async function clearPromptInUi(page) {
  await closeAssetDrawerIfOpen(page);
  const clearBtn = page
    .locator('button[aria-label*="Hapus perintah" i], button[aria-label*="Clear prompt" i]')
    .first();
  if (await clearBtn.count()) {
    await clearBtn.click().catch(() => {});
    await page
      .waitForFunction(
        () => document.querySelectorAll('flow-ingredient-bar flow-ingredient-chip').length === 0,
        null,
        { timeout: 400, polling: 40 }
      )
      .catch(() => {});
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const chips = page.locator(
      'flow-ingredient-bar flow-ingredient-chip, .prompt-ingredient-bar flow-ingredient-chip, flow-ingredient-bar button.chip-container, flow-ingredient-bar button[aria-label="Bahan"]'
    );
    const chipCount = await chips.count();
    if (chipCount === 0) break;

    const firstChip = chips.first();
    await firstChip.hover().catch(() => {});
    await page.waitForTimeout(40);

    const cancelOverlay = firstChip
      .locator(
        '.disabled-cancel-icon, .hover-icon-overlay, [aria-label*="hapus" i], [aria-label*="remove" i], mat-icon:has-text("cancel"), mat-icon:has-text("close")'
      )
      .first();

    if (await cancelOverlay.count()) {
      await cancelOverlay.click({ force: true }).catch(() => {});
    } else {
      await firstChip.click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(50);
    await closeAssetDrawerIfOpen(page);
  }

  const composer = getComposerLocator(page);
  if (!(await composer.count())) {
    throw new Error(
      'Could not locate the ProseMirror prompt composer (`div.ProseMirror[role="textbox"]`). Open a project first.'
    );
  }
  await composer.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(40);
  return true;
}

async function stagePromptInUi(page, { prompt, clear = false, mode = null }) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error('Prompt text cannot be empty.');
  }

  await closeAssetDrawerIfOpen(page);

  if (mode) {
    await selectComposerModeInUi(page, mode).catch(() => {});
  }

  const composer = getComposerLocator(page);
  if (!(await composer.count())) {
    throw new Error(
      'Could not locate the main Google Flow prompt composer on this page. Open a project first (`flow-canvas project use <id>` or `flow-canvas project create`), or run `flow-canvas project inspect`.'
    );
  }

  await composer.click();
  const existingText = (await composer.innerText().catch(() => '')).trim();

  if (clear) {
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
  } else if (existingText) {
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText(' ');
  }

  const textToStage = String(prompt);
  await page.keyboard.insertText(textToStage);
  await page.waitForTimeout(60);

  const finalText = (await composer.innerText().catch(() => '')).trim();

  return {
    staged: true,
    composerSelector: 'div.ProseMirror[role="textbox"]',
    clearedPrevious: Boolean(clear),
    promptLength: textToStage.length,
    composerPreview: finalText.slice(0, 200),
    generateClicked: false,
  };
}

module.exports = {
  MAX_DIALOG_LENGTH,
  stripIconLigature,
  detectAuthAndPageState,
  readComposerState,
  inspectPageDom,
  listProjectsFromUi,
  createNewProjectInUi,
  isAssetDrawerOpen,
  ensureAssetDrawerOpen,
  closeAssetDrawerIfOpen,
  openAssetTab,
  searchAssetsInDrawer,
  readVisibleAssets,
  attachDrawerCard,
  uploadFilesInUi,
  attachAssetInUi,
  configureVoiceInUi,
  selectComposerModeInUi,
  clearPromptInUi,
  stagePromptInUi,
};
