# Cozy Theme UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the extension as a cozy study desk UI and add persisted system/light/dark theme selection.

**Architecture:** Keep the extension framework-free. Put reusable theme preference helpers in `content-core.js`, use `content.js` for panel state/control wiring, and express the visual system through CSS variables in `content.css` and `popup.css`.

**Tech Stack:** MV3 browser extension, vanilla JavaScript, CSS variables, localStorage, existing Node regression test file.

---

## File Structure

- Modify `content-core.js`: add pure theme helper functions that can be unit tested in Node.
- Modify `tests/performance-optimizations.test.js`: add tests for theme preference normalization and resolution.
- Modify `content.js`: load/save theme preference, resolve system theme, render the theme segmented control, and update `data-theme`.
- Modify `content.css`: replace the current dark-only palette with cozy light/dark variables and style the theme control.
- Modify `popup.css`: restyle popup with the same cozy light/dark palette using `prefers-color-scheme`.
- Modify `docs/NEXT.md`: note the UI/theme work as the current recent state after implementation.

## Task 1: Theme Helper TDD

**Files:**
- Modify: `tests/performance-optimizations.test.js`
- Modify: `content-core.js`

- [ ] **Step 1: Write failing tests**

Add tests that call:

```js
contentCore.normalizeThemePreference("light") === "light"
contentCore.normalizeThemePreference("dark") === "dark"
contentCore.normalizeThemePreference("bad-value") === "system"
contentCore.resolveThemeName("system", true) === "dark"
contentCore.resolveThemeName("system", false) === "light"
contentCore.resolveThemeName("light", true) === "light"
contentCore.resolveThemeName("dark", false) === "dark"
```

- [ ] **Step 2: Verify red**

Run:

```sh
node tests/performance-optimizations.test.js
```

Expected: fail because `contentCore.normalizeThemePreference` is missing.

- [ ] **Step 3: Implement helpers**

Add `normalizeThemePreference(value)` and `resolveThemeName(preference, systemPrefersDark)` to `content-core.js`, export both through the existing API object.

- [ ] **Step 4: Verify green**

Run:

```sh
node tests/performance-optimizations.test.js
```

Expected: all existing tests and new theme tests pass.

## Task 2: Panel Theme State And Control

**Files:**
- Modify: `content.js`
- Depends on: Task 1 helpers

- [ ] **Step 1: Add constants and state**

Add a theme storage key, theme preference state, resolved theme state, and a `matchMedia("(prefers-color-scheme: dark)")` handle.

- [ ] **Step 2: Render control**

Add a compact segmented control in the panel header with buttons for `系统`, `浅色`, and `暗色`.

- [ ] **Step 3: Wire behavior**

Load preference at boot, save on click, apply `data-theme` and `data-theme-preference` on the panel, and update button selected states.

- [ ] **Step 4: System theme listener**

When the browser color scheme changes, refresh the resolved theme only if preference is `system`.

## Task 3: Cozy Panel CSS

**Files:**
- Modify: `content.css`

- [ ] **Step 1: Define token sets**

Replace the root dark-only variables with cozy shared tokens plus `data-theme="light"` and `data-theme="dark"` overrides.

- [ ] **Step 2: Restyle chrome**

Restyle panel, header, toolbar, status, buttons, inputs, selects, close menu, scrollbar, tooltip, drag ghost, and active page highlight using the new variables.

- [ ] **Step 3: Restyle tree SVG**

Update node/link/search/drag colors to fit both themes while retaining contrast.

- [ ] **Step 4: Check responsive fit**

Ensure header buttons and the theme segmented control wrap cleanly at narrow widths.

## Task 4: Cozy Popup CSS

**Files:**
- Modify: `popup.css`

- [ ] **Step 1: Define light tokens**

Make the popup default to cozy light mode.

- [ ] **Step 2: Define dark tokens**

Use `@media (prefers-color-scheme: dark)` to switch to the matching dark palette.

- [ ] **Step 3: Restyle controls**

Update cards, status pill, note area, and buttons to match the panel.

## Task 5: Docs And Verification

**Files:**
- Modify: `docs/NEXT.md`

- [ ] **Step 1: Update recent state**

Mention that the active UI direction is cozy study desk with theme selection.

- [ ] **Step 2: Run verification**

Run:

```sh
node tests/performance-optimizations.test.js
git diff --check
```

Expected: tests pass and diff check has no output.

- [ ] **Step 3: Commit and push**

Stage only project files, excluding `.superpowers/` and `dist/`, then commit with:

```sh
git commit -m "实现暖桌面手账主题"
git push origin main
```

## Self-Review

- Spec coverage: the plan covers cozy restyle, panel and popup themes, default system behavior, manual light/dark override, local persistence, and verification.
- Placeholder scan: no TBD or deferred behavior remains.
- Type consistency: preference values are `system`, `light`, and `dark` across helpers, content script, CSS attributes, and tests.
