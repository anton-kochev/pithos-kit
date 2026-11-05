import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { InteractiveMode } from './runtime/dist/modes/interactive/interactive-mode.js';
import { CustomEditor } from './runtime/dist/modes/interactive/components/custom-editor.js';
import { ExtensionRunner } from './runtime/dist/core/extensions/runner.js';
import { createExtensionRuntime } from './runtime/dist/core/extensions/loader.js';
import { SettingsManager } from './runtime/dist/core/settings-manager.js';
import { SessionManager } from './runtime/dist/core/session-manager.js';
import { TuiMainScreen } from './runtime/node_modules/@earendil-works/pi-tui/dist/index.js';

// No ProcessTerminal, init/run, AgentSession or provider is started. Only the session boundary is fake.
class RecordingTerminal {
  columns = 80; rows = 24; kittyProtocolActive = false; writes = []; starts = 0; stops = 0;
  start(input, resize) { this.input = input; this.resize = resize; this.starts++; }
  stop() { this.input = undefined; this.stops++; }
  send(data) { assert.equal(typeof this.input, 'function'); this.input(data); }
  write(data) { this.writes.push(data); }
  drainInput() { return Promise.resolve(); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  setTitle() {} setProgress() {} setProgramStatus() {}
}
function fixture(t, settings = {}) {
  const terminal = new RecordingTerminal();
  const trace = [];
  const sessionManager = SessionManager.inMemory(process.cwd());
  const session = {
    sessionManager, settingsManager: SettingsManager.inMemory({ theme: 'dark', doubleEscapeAction: 'none', ...settings }),
    resourceLoader: { getThemes: () => ({ themes: [] }), getSkills: () => ({ skills: [] }) },
    agent: {}, scopedModels: [], promptTemplates: [], thinkingLevel: 'off', isStreaming: false, isBashRunning: false,
    isCompacting: false, isIdle: true,
    clearQueue: () => { trace.push('clearQueue'); return { steering: [], followUp: [] }; },
    getSteeringMessages: () => [], getFollowUpMessages: () => [],
    abort: () => { trace.push('abort'); }, abortBash: () => trace.push('bash'),
    abortCompaction: () => trace.push('compaction'), abortRetry: () => trace.push('retry'),
    abortBranchSummary: () => trace.push('summary'),
  };
  const mode = new InteractiveMode({ session, setBeforeSessionInvalidate() {}, setRebindSession() {},
    beginContinuationTransition: () => () => {}, beginContinuationInput: () => () => {}, requestContinuationShutdown() {} }, { terminal, tuiMode: 'regular' });
  assert(mode.renderer instanceof TuiMainScreen);
  assert(mode.defaultEditor instanceof CustomEditor);
  mode.setupKeyHandlers();
  mode.ui.addChild(mode.editorContainer);
  mode.ui.setFocus(mode.editor);
  mode.ui.start();
  mode.isInitialized = true; // handleEvent must not call init(). No startup or model work.
  const raw = mode.createExtensionUIContext();
  const runner = new ExtensionRunner([], createExtensionRuntime(), process.cwd(), sessionManager, {});
  runner.setUIContext(raw, 'tui');
  session.extensionRunner = runner;
  t.after(() => {
    // Safety cleanup independent of teardown-under-test (some tests deliberately make disposal throw).
    mode.activeStatusIndicator?.dispose();
    mode.themeController.dispose();
    mode.footer.dispose();
    mode.footerDataProvider.dispose();
    mode.renderer.stop();
    runner.invalidate();
  });
  return { mode, raw, ui: runner.getUIContext(), runner, session, terminal, trace };
}

test('basic semantic notification precedes native dispatch without consuming or awaiting', async t => {
  const { mode, ui, session, terminal, trace } = fixture(t);
  assert.equal(typeof ui.semanticInterrupt.subscribe, 'function', 'TUI must expose semanticInterrupt.subscribe');
  const duplicate = () => { trace.push('duplicate'); };
  const first = ui.semanticInterrupt.subscribe(duplicate, () => {});
  ui.semanticInterrupt.subscribe(duplicate, () => {});
  first(); first();
  ui.semanticInterrupt.subscribe(() => { trace.push('prefix'); return new Promise(() => {}); }, () => {});
  ui.semanticInterrupt.subscribe(() => { trace.push('return'); return { consume: true }; }, () => {});
  terminal.send('\x1b');
  assert.deepEqual(trace, ['duplicate', 'prefix', 'return'], 'idle interrupt must not abort');
  trace.length = 0;
  mode.editor.setText('nonempty');
  session.isStreaming = true;
  terminal.send('\x1b');
  assert.deepEqual(trace, ['duplicate', 'prefix', 'return', 'clearQueue', 'abort']);

  let removeLater;
  const removeReentrant = ui.semanticInterrupt.subscribe(() => {
    trace.push('reentrant'); removeLater(); ui.semanticInterrupt.subscribe(() => { trace.push('new'); }, () => {});
  }, () => {});
  removeLater = ui.semanticInterrupt.subscribe(() => { trace.push('removed'); }, () => {});
  trace.length = 0;
  terminal.send('\x1b');
  assert.deepEqual(trace, ['duplicate', 'prefix', 'return', 'reentrant', 'clearQueue', 'abort']);
  removeReentrant();
  trace.length = 0;
  terminal.send('\x1b');
  assert.deepEqual(trace, ['duplicate', 'prefix', 'return', 'new', 'clearQueue', 'abort']);

  const diagnostics = [];
  mode.showError = message => { diagnostics.push(message); throw new Error('diagnostic sink failed'); };
  ui.semanticInterrupt.subscribe(() => { throw new Error('listener throw'); }, () => {});
  ui.semanticInterrupt.subscribe(() => { throw { toString() { throw new Error('hostile conversion'); } }; }, () => {});
  ui.semanticInterrupt.subscribe(() => Promise.reject(new Error('listener rejection')), () => {});
  ui.semanticInterrupt.subscribe(() => { trace.push('after errors'); }, () => {});
  trace.length = 0;
  terminal.send('\x1b');
  assert.deepEqual(trace.slice(-3), ['after errors', 'clearQueue', 'abort']);
  await tick();
  assert(diagnostics.some(x => x.includes('listener throw')));
  assert(diagnostics.some(x => x.includes('listener rejection')));
  // node:test fails the test on an unhandled rejection; leave an extra turn for that diagnostic.
  await tick();
  session.abort = () => { throw new Error('native failure'); };
  assert.throws(() => terminal.send('\x1b'), /native failure/);
});

function customFactory(duck) {
  return (tui, theme, keys) => {
    const inner = new CustomEditor(tui, theme, keys);
    if (!duck) return inner;
    // A non-CustomEditor adapter as across jiti boundaries. Routing is still the real editor's.
    const adapter = { actionHandlers: inner.actionHandlers };
    for (const key of ['onEscape', 'onCtrlD', 'onPasteImage', 'onExtensionShortcut', 'onSubmit', 'onChange', 'focused']) {
      Object.defineProperty(adapter, key, { get: () => inner[key], set: value => { inner[key] = value; } });
    }
    for (const key of ['getText', 'setText', 'handleInput', 'render', 'invalidate']) adapter[key] = inner[key].bind(inner);
    assert(!(adapter instanceof CustomEditor));
    return adapter;
  };
}

test('temporary compaction and retry callbacks notify and restore dynamic custom fallback', async t => {
  for (const duck of [false, true]) {
    await t.test(duck ? 'duck adapter' : 'CustomEditor', async t => {
      const { mode, ui, terminal, trace } = fixture(t);
      ui.semanticInterrupt.subscribe(() => { trace.push('interrupt'); }, () => {});
      ui.setEditorComponent(customFactory(duck));
      const native = mode.defaultEditor.onEscape;
      const fallback = mode.editor.onEscape;
      await mode.handleEvent({ type: 'compaction_start', reason: 'manual' });
      terminal.send('\x1b');
      assert.deepEqual(trace, ['interrupt', 'compaction']);
      await mode.handleEvent({ type: 'compaction_end', reason: 'manual', aborted: true, willRetry: false });
      assert.equal(mode.defaultEditor.onEscape, native);
      trace.length = 0;
      terminal.send('\x1b');
      assert.deepEqual(trace, ['interrupt']);
      trace.length = 0;
      await mode.handleEvent({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 1000 });
      terminal.send('\x1b');
      assert.deepEqual(trace, ['interrupt', 'retry']);
      await mode.handleEvent({ type: 'auto_retry_end', success: true });
      assert.equal(mode.defaultEditor.onEscape, native);
      assert.equal(mode.editor.onEscape, fallback);
      trace.length = 0;
      terminal.send('\x1b');
      assert.deepEqual(trace, ['interrupt']);
      await mode.handleEvent({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 1000 });
      await mode.handleEvent({ type: 'agent_start' });
      assert.equal(mode.defaultEditor.onEscape, native);
    });
  }
});

test('branch summary notifies first and restores the saved native callback', async t => {
  const { mode, ui, session, terminal, trace } = fixture(t);
  ui.semanticInterrupt.subscribe(() => { trace.push('interrupt'); }, () => {});
  ui.setEditorComponent(customFactory(true));
  const native = mode.defaultEditor.onEscape;
  const target = session.sessionManager.appendMessage({ role: 'user', content: 'first', timestamp: Date.now() });
  session.sessionManager.appendMessage({ role: 'user', content: 'second', timestamp: Date.now() });
  let finish;
  session.navigateTree = (id, options) => {
    assert.equal(id, target); assert.equal(options.summarize, true);
    return new Promise(resolve => { finish = resolve; });
  };
  mode.showTreeSelector(target);
  terminal.send('\r');
  terminal.send('\x1b[B');
  terminal.send('\r');
  await tick();
  assert.equal(typeof finish, 'function', 'real tree and summary selectors started navigation');
  assert.notEqual(mode.defaultEditor.onEscape, native);
  terminal.send('\x1b');
  finish({ cancelled: true });
  await tick();
  assert.deepEqual(trace, ['interrupt', 'summary']);
  assert.equal(mode.defaultEditor.onEscape, native);
  trace.length = 0;
  terminal.send('\x1b');
  assert.deepEqual(trace, ['interrupt']);
});

test('retirement clears subscriptions before failing reset or stop disposal and silences late errors', async t => {
  for (const action of ['reset', 'stop']) {
    await t.test(action, async t => {
      const { mode, raw, terminal, trace } = fixture(t);
      let reject;
      const diagnostics = [];
      mode.showError = message => diagnostics.push(message);
      raw.semanticInterrupt.subscribe(() => new Promise((_, fail) => { reject = fail; }), () => {});
      raw.semanticInterrupt.subscribe(() => { trace.push('listener'); }, () => {});
      terminal.send('\x1b');
      assert.deepEqual(trace, ['listener']);
      trace.length = 0;
      if (action === 'reset') {
        mode.extensionDialogs.push({ component: { dispose() { throw new Error('dispose failed'); } } });
        assert.throws(() => mode.resetExtensionUI(), /dispose failed/);
      } else {
        mode.activeSelectorDispose = () => {
          assert.throws(() => raw.semanticInterrupt.subscribe(() => {}, () => {}), /stopped|closed/i);
          throw new Error('dispose failed');
        };
        assert.throws(() => mode.stop(), /dispose failed/);
        assert.throws(() => raw.semanticInterrupt.subscribe(() => {}, () => {}), /stopped|closed/i);
      }
      reject(new Error('retired asynchronous failure'));
      await tick();
      terminal.send('\x1b');
      assert.deepEqual(trace, []);
      assert.deepEqual(diagnostics, []);
      if (action === 'reset') {
        raw.semanticInterrupt.subscribe(() => { trace.push('fresh'); }, () => {});
        terminal.send('\x1b');
        assert.deepEqual(trace, ['fresh']);
      }
    });
  }
});

test('reset fence rejects runner-bound registration from a throwing disposer without callbacks or late diagnostics', async t => {
  const { mode, raw, runner, terminal, trace } = fixture(t);
  const capturedUI = runner.createContext().ui;
  assert.notEqual(capturedUI, raw, 'exercise the real runner binding, not just the raw host UI');
  const diagnostics = [];
  mode.showError = message => diagnostics.push(message);
  let reject;
  capturedUI.semanticInterrupt.subscribe(() => new Promise((_, fail) => { reject = fail; }), () => {});
  capturedUI.semanticInterrupt.subscribe(() => { trace.push('existing'); }, () => {});
  terminal.send('\x1b');
  assert.deepEqual(trace, ['existing']);
  trace.length = 0;

  const disposalError = new Error('disposer failed after registration attempt');
  let registrationError;
  mode.extensionDialogs.push({ component: { dispose() {
    try {
      capturedUI.semanticInterrupt.subscribe(() => {
        trace.push('teardown-created');
        return Promise.reject(new Error('teardown-created rejection'));
      }, () => {});
    } catch (error) { registrationError = error; }
    terminal.send('\x1b'); // A final clear alone would still allow callbacks inside the disposer.
    throw disposalError;
  } } });
  assert.throws(() => mode.resetExtensionUI(), error => error === disposalError);
  // Intentionally do not invalidate/rebind the runner: failed reset can prevent that later cleanup.
  terminal.send('\x1b');
  reject(new Error('retired pending rejection'));
  await tick();
  await tick();
  assert.deepEqual(trace, [], 'no existing or teardown-created callback may survive reset');
  assert.deepEqual(diagnostics, [], 'no retired or teardown-created rejection may repaint');
  assert.match(registrationError?.message ?? '', /reset/i);

  const remove = capturedUI.semanticInterrupt.subscribe(() => { trace.push('after failed reset'); }, () => {});
  terminal.send('\x1b');
  assert.deepEqual(trace, ['after failed reset']);
  remove();
  mode.extensionDialogs = [];
  mode.resetExtensionUI();
  runner.setUIContext(raw, 'tui');
  runner.createContext().ui.semanticInterrupt.subscribe(() => { trace.push('new binding'); }, () => {});
  terminal.send('\x1b');
  assert.deepEqual(trace, ['after failed reset', 'new binding']);
});

test('reset fence remains closed until outer cleanup finishes after nested reset', async t => {
  for (const nestedOutcome of ['returns', 'throws']) {
    await t.test(nestedOutcome, async t => {
      const { mode, runner, terminal, trace } = fixture(t);
      const capturedUI = runner.createContext().ui;
      const diagnostics = [];
      mode.showError = message => diagnostics.push(message);
      const nestedError = new Error('nested disposal failed');
      const outerError = new Error('outer disposal failed');
      let entered = false;
      let registrationError;
      mode.extensionDialogs.push({ component: { dispose() {
        // An idempotent disposer lets the real reset re-enter without recursive disposal forever.
        if (entered) {
          if (nestedOutcome === 'throws') throw nestedError;
          return;
        }
        entered = true;
        if (nestedOutcome === 'throws') {
          assert.throws(() => mode.resetExtensionUI(), error => error === nestedError);
        } else {
          mode.resetExtensionUI();
        }
        try {
          capturedUI.semanticInterrupt.subscribe(() => {
            trace.push('registered before outer reset finished');
            return Promise.reject(new Error('nested reset leak'));
          }, () => {});
        } catch (error) { registrationError = error; }
        terminal.send('\x1b');
        throw outerError;
      } } });
      assert.throws(() => mode.resetExtensionUI(), error => error === outerError);
      terminal.send('\x1b');
      await tick();
      await tick();
      assert.deepEqual(trace, [], 'nested reset must not reopen registration inside outer disposal');
      assert.deepEqual(diagnostics, []);
      assert.match(registrationError?.message ?? '', /reset/i);
      capturedUI.semanticInterrupt.subscribe(() => { trace.push('after outer reset'); }, () => {});
      terminal.send('\x1b');
      assert.deepEqual(trace, ['after outer reset']);
    });
  }
});

test('reset during dispatch skips retired snapshot entries and defers new registrations', t => {
  const { mode, raw, terminal, trace } = fixture(t);
  raw.semanticInterrupt.subscribe(() => {
    trace.push('reset'); mode.resetExtensionUI();
    raw.semanticInterrupt.subscribe(() => { trace.push('new'); }, () => {});
  }, () => {});
  raw.semanticInterrupt.subscribe(() => { trace.push('retired'); }, () => {});
  terminal.send('\x1b');
  assert.deepEqual(trace, ['reset']);
  terminal.send('\x1b');
  assert.deepEqual(trace, ['reset', 'new']);
});

test('runner binding retires registrations on rebind and invalidate, including shutdown-time work', async t => {
  const { mode, raw, runner, terminal, trace, session } = fixture(t);
  const oldUI = runner.createContext().ui;
  const savedRegister = oldUI.semanticInterrupt.subscribe;
  const removed = savedRegister(() => { trace.push('removed'); }, () => {});
  const duplicate = () => { trace.push('duplicate'); };
  savedRegister(duplicate, () => {}); savedRegister(duplicate, () => {});
  removed(); removed();
  terminal.send('\x1b');
  assert.deepEqual(trace, ['duplicate', 'duplicate']);
  trace.length = 0;
  let reject;
  const diagnostics = [];
  mode.showError = message => diagnostics.push(message);
  savedRegister(() => new Promise((_, fail) => { reject = fail; }), () => {});
  terminal.send('\x1b');
  trace.length = 0;
  runner.setUIContext(raw, 'tui');
  terminal.send('\x1b');
  assert.deepEqual(trace, [], 'rebind must unsubscribe the old binding');
  assert.throws(() => savedRegister(() => {}, () => {}), /stale/i);
  assert.throws(() => oldUI.semanticInterrupt.subscribe(() => {}, () => {}), /stale/i);
  reject(new Error('old binding rejection'));
  await tick();
  assert.deepEqual(diagnostics, []);
  const current = runner.getUIContext();
  current.semanticInterrupt.subscribe(() => { trace.push('current'); }, () => {});
  runner.extensions.push({ path: '<shutdown>', handlers: new Map([['session_shutdown', [(_event, ctx) => {
    ctx.ui.semanticInterrupt.subscribe(() => { trace.push('shutdown'); }, () => {});
  }]]]) });
  await runner.emit({ type: 'session_shutdown', reason: 'reload' });
  terminal.send('\x1b');
  assert.deepEqual(trace, ['current', 'shutdown']);
  trace.length = 0;
  runner.invalidate();
  terminal.send('\x1b');
  assert.deepEqual(trace, []);
  assert.throws(() => current.semanticInterrupt.subscribe(() => {}, () => {}), /stale/i);
  assert.throws(() => runner.setUIContext(raw, 'tui'), /stale/i);
  const fresh = new ExtensionRunner([], createExtensionRuntime(), process.cwd(), session.sessionManager, {});
  t.after(() => fresh.invalidate());
  fresh.setUIContext(raw, 'tui');
  fresh.getUIContext().semanticInterrupt.subscribe(() => { trace.push('fresh'); }, () => {});
  terminal.send('\x1b');
  assert.deepEqual(trace, ['fresh']);
  fresh.setUIContext();
  assert.equal(fresh.getUIContext().semanticInterrupt, undefined, 'non-TUI no-op must omit the capability');
  trace.length = 0;
  terminal.send('\x1b');
  assert.deepEqual(trace, []);
});

test('shortcut registration uses the runner-bound UI and retires with its binding', t => {
  const { mode, runner, ui, terminal, trace } = fixture(t);
  let shortcutUI;
  runner.extensions.push({
    path: '<shortcut>', shortcuts: new Map([['f8', { shortcut: 'f8', extensionPath: '<shortcut>', handler(ctx) {
      trace.push('shortcut'); shortcutUI = ctx.ui;
      ctx.ui.semanticInterrupt.subscribe(() => { trace.push('registered'); }, () => {});
    } }]]),
  });
  ui.semanticInterrupt.subscribe(() => { trace.push('existing'); }, () => {});
  mode.setupExtensionShortcuts(runner);
  terminal.send('\x1b[19~');
  assert.deepEqual(trace, ['shortcut'], 'extension shortcut consumption must not produce an interrupt');
  assert.equal(shortcutUI, runner.getUIContext());
  terminal.send('\x1b');
  assert.deepEqual(trace, ['shortcut', 'existing', 'registered']);
  trace.length = 0;
  runner.invalidate();
  terminal.send('\x1b');
  assert.deepEqual(trace, []);
  assert.throws(() => shortcutUI.semanticInterrupt.subscribe(() => {}, () => {}), /stale/i);
});

test('routing honors ordinary, remapped and disabled interrupt bindings', t => {
  const { mode, ui, terminal, trace } = fixture(t);
  ui.semanticInterrupt.subscribe(() => { trace.push('interrupt'); }, () => {});
  terminal.send('\x1b');
  assert.deepEqual(trace, ['interrupt']);
  trace.length = 0;
  mode.keybindings.setUserBindings({ 'app.interrupt': 'ctrl+]' });
  terminal.send('\x1b');
  assert.deepEqual(trace, []);
  terminal.send('\x1d');
  assert.deepEqual(trace, ['interrupt']);
  trace.length = 0;
  mode.keybindings.setUserBindings({ 'app.interrupt': [] });
  terminal.send('\x1b'); terminal.send('\x1d');
  assert.deepEqual(trace, []);
});

test('routing raw consume and transform and Guild-like panel listener do not report false interrupts', t => {
  const { mode, ui, terminal, trace } = fixture(t);
  ui.semanticInterrupt.subscribe(() => { trace.push('interrupt'); }, () => {});
  let panel = true;
  const close = ui.onTerminalInput(data => {
    if (panel && data === '\x1b') { trace.push('panel'); return { consume: true }; }
  });
  terminal.send('\x1b');
  assert.deepEqual(trace, ['panel']);
  panel = false;
  terminal.send('\x1b');
  assert.deepEqual(trace, ['panel', 'interrupt']);
  close();
  trace.length = 0;
  const transform = ui.onTerminalInput(data => ({ data: data === '\x1b' ? 'x' : '\x1b' }));
  terminal.send('\x1b');
  assert.deepEqual(trace, []);
  assert.equal(mode.editor.getText(), 'x');
  terminal.send('z');
  assert.deepEqual(trace, ['interrupt']);
  transform();
});

test('routing autocomplete, focused picker and capturing overlay consume Escape without notification', async t => {
  const { mode, ui, terminal, trace } = fixture(t);
  ui.semanticInterrupt.subscribe(() => { trace.push('interrupt'); }, () => {});
  mode.setupAutocompleteProvider();
  terminal.send('/');
  await tick();
  assert.equal(mode.editor.isShowingAutocomplete(), true);
  terminal.send('\x1b');
  assert.equal(mode.editor.isShowingAutocomplete(), false);
  assert.deepEqual(trace, []);
  terminal.send('\x1b');
  assert.deepEqual(trace, ['interrupt']);
  trace.length = 0;
  const choice = ui.select('Pick', ['one', 'two']);
  terminal.send('\x1b');
  assert.equal(await choice, undefined);
  assert.deepEqual(trace, []);
  const overlay = ui.custom((_tui, _theme, _keys, done) => ({
    render: () => ['capturing overlay'], invalidate() {},
    handleInput(data) { if (data === '\x1b') { trace.push('overlay'); done('closed'); } },
  }), { overlay: true });
  await tick();
  terminal.send('\x1b');
  assert.equal(await overlay, 'closed');
  assert.deepEqual(trace, ['overlay']);
  trace.length = 0;
  terminal.send('\x1b');
  assert.deepEqual(trace, ['interrupt']);
});

test('routing idle/nonempty and double-Escape tree/fork/none keep native behavior', async t => {
  for (const action of ['tree', 'fork', 'none']) {
    await t.test(action, t => {
      const { mode, ui, session, terminal, trace } = fixture(t, { doubleEscapeAction: action });
      const id = session.sessionManager.appendMessage({ role: 'user', content: 'message', timestamp: Date.now() });
      session.getUserMessagesForForking = () => [{ entryId: id, text: 'message' }];
      ui.semanticInterrupt.subscribe(() => { trace.push('interrupt'); }, () => {});
      mode.editor.setText('nonempty');
      terminal.send('\x1b');
      assert.equal(mode.editor.getText(), 'nonempty');
      assert.equal(mode.ui.getFocusedComponent(), mode.editor);
      assert.deepEqual(trace, ['interrupt']);
      mode.editor.setText(''); trace.length = 0;
      t.mock.method(Date, 'now', () => 100000);
      terminal.send('\x1b'); terminal.send('\x1b');
      assert.deepEqual(trace, ['interrupt', 'interrupt']);
      if (action === 'none') {
        assert.equal(mode.ui.getFocusedComponent(), mode.editor);
      } else {
        assert.notEqual(mode.ui.getFocusedComponent(), mode.editor);
        assert.equal(mode.editorContainer.children[0].constructor.name,
          action === 'tree' ? 'TreeSelectorComponent' : 'UserMessageSelectorComponent');
        terminal.send('\x1b');
        assert.deepEqual(trace, ['interrupt', 'interrupt'], 'closing the picker is not a native interrupt');
        assert.equal(mode.ui.getFocusedComponent(), mode.editor);
      }
      trace.length = 0;
      session.isBashRunning = true;
      terminal.send('\x1b');
      assert.deepEqual(trace, ['interrupt', 'bash']);
      session.isBashRunning = false;
      mode.editor.setText('!command');
      trace.length = 0;
      terminal.send('\x1b');
      assert.deepEqual(trace, ['interrupt']);
      assert.equal(mode.editor.getText(), '');
      assert.equal(mode.isBashMode, false);
    });
  }
});

test('lifecycle renderer toggles and suspend/resume retain interrupt subscriptions', t => {
  const { mode, ui, terminal, trace } = fixture(t);
  ui.semanticInterrupt.subscribe(() => { trace.push('interrupt'); }, () => {});
  mode.fullscreenLayoutRoot = mode.editorContainer;
  assert.equal(mode.switchTuiMode('fullscreen', false), true);
  terminal.send('\x1b');
  assert.deepEqual(trace, ['interrupt']);
  assert.equal(mode.switchTuiMode('regular', false), true);
  terminal.send('\x1b');
  assert.deepEqual(trace, ['interrupt', 'interrupt']);
  const signals = [];
  t.mock.method(process, 'kill', (pid, signal) => { signals.push([pid, signal]); return true; });
  try {
    terminal.send('\x1a'); // real app.suspend handler, with only the OS signal boundary replaced
    assert.deepEqual(signals, [[0, 'SIGTSTP']]);
  } finally {
    process.emit('SIGCONT');
  }
  terminal.send('\x1b');
  assert.deepEqual(trace, ['interrupt', 'interrupt', 'interrupt']);
  assert.equal(terminal.starts, 4);
});

test('lifecycle runner retires binding before hostile unsubscribe and continues cleaning', async t => {
  for (const action of ['rebind', 'invalidate']) {
    await t.test(action, t => {
      const { raw, runner, terminal, trace } = fixture(t);
      let savedRegister;
      const attempts = [];
      let cleanups = 0;
      const host = { ...raw, semanticInterrupt: { protocol: 'pi-semantic-interrupt-v1', subscribe(handler, retire) {
        const unsubscribe = raw.semanticInterrupt.subscribe(handler, retire);
        return () => {
          unsubscribe(); cleanups++;
          try { savedRegister(() => { trace.push('leaked'); }, () => {}); attempts.push('accepted'); }
          catch { attempts.push('rejected'); }
          if (cleanups === 1) throw new Error('one host cleanup failed');
        };
      } } };
      runner.setUIContext(host, 'tui');
      savedRegister = runner.getUIContext().semanticInterrupt.subscribe;
      savedRegister(() => { trace.push('one'); }, () => {});
      savedRegister(() => { trace.push('two'); }, () => {});
      if (action === 'rebind') runner.setUIContext(raw, 'tui');
      else runner.invalidate();
      assert.equal(cleanups, 2);
      assert.deepEqual(attempts, ['rejected', 'rejected']);
      terminal.send('\x1b');
      assert.deepEqual(trace, []);
    });
  }
});

test('host retirement is synchronous, first-reason-only, fenced and isolated for each unique subscription', async t => {
  for (const action of ['reset', 'stop']) {
    await t.test(action, async t => {
      const { mode, raw, runner, terminal, trace } = fixture(t);
      const capability = raw.semanticInterrupt;
      assert.equal(capability.protocol, 'pi-semantic-interrupt-v1');
      assert.equal(raw.onInterrupt, undefined, 'no unpublished prototype alias');
      const retired = [], registrationErrors = [];
      const handler = () => trace.push('interrupt');
      const manual = capability.subscribe(handler, () => assert.fail('manual unsubscribe is silent'));
      manual(); manual();
      const old = capability.subscribe(handler, reason => {
        retired.push(reason);
        try { capability.subscribe(handler, () => {}); }
        catch (error) { registrationErrors.push(error.message); }
        terminal.send('\x1b');
        throw new Error('retirement throw');
      });
      capability.subscribe(handler, reason => { retired.push(reason); return Promise.reject(new Error('retirement rejection')); });
      const boundRetired = [];
      runner.getUIContext().semanticInterrupt.subscribe(handler, reason => boundRetired.push(reason));
      if (action === 'reset') mode.resetExtensionUI(); else mode.stop();
      assert.deepEqual(retired, [`ui-${action}`, `ui-${action}`]);
      assert.equal(registrationErrors.length, 1);
      assert.match(registrationErrors[0], /reset|stopped/i);
      assert.deepEqual(trace, [], 'all records detached before the first callback');
      assert.deepEqual(boundRetired, [`ui-${action}`]);
      runner.invalidate();
      assert.deepEqual(boundRetired, [`ui-${action}`], 'host retirement then invalidation is not double retirement');
      old(); old();
      if (action === 'reset') {
        capability.subscribe(handler, () => {});
        old();
        terminal.send('\x1b');
        assert.deepEqual(trace, ['interrupt']);
      }
      await tick(); await tick();
    });
  }
});

test('runner retirement fences all records before callbacks, isolates notification and cleanup, and rejects transition reentry', async t => {
  for (const action of ['rebind', 'invalidate']) {
    await t.test(action, async t => {
      const { raw, runner, trace } = fixture(t);
      const callbacks = [], retired = [], cleanup = [], reentryErrors = [];
      const capability = { protocol: 'pi-semantic-interrupt-v1', subscribe(handler, retire) {
        assert.equal(this, capability, 'raw method receiver preserved');
        callbacks.push({ handler, retire });
        const id = callbacks.length;
        return () => { cleanup.push(id); if (id === 1) throw new Error('cleanup throw'); return Promise.reject(new Error('cleanup rejection')); };
      } };
      runner.setUIContext({ ...raw, semanticInterrupt: capability }, 'tui');
      const ui = runner.getUIContext();
      assert.notEqual(ui.semanticInterrupt, capability);
      const register = ui.semanticInterrupt.subscribe;
      register(() => trace.push('one'), reason => {
        retired.push(reason);
        callbacks[1].handler();
        try { register(() => {}, () => {}); } catch (error) { reentryErrors.push(error.message); }
        try { runner.setUIContext(raw, 'tui'); } catch (error) { reentryErrors.push(error.message); }
        throw new Error('notification throw');
      });
      const remove = register(() => trace.push('two'), reason => { retired.push(reason); return Promise.reject(new Error('notification rejection')); });
      if (action === 'rebind') runner.setUIContext(raw, 'tui'); else runner.invalidate();
      assert.deepEqual(retired, [`runner-${action}`, `runner-${action}`]);
      assert.deepEqual(cleanup, [1, 2]);
      assert.equal(reentryErrors.length, 2);
      assert.match(reentryErrors[0], /stale/i);
      assert.match(reentryErrors[1], /transition|stale/i);
      assert.deepEqual(trace, []);
      remove(); remove();
      callbacks.forEach(({ handler, retire }) => { handler(); retire('ui-stop'); });
      assert.deepEqual(retired, [`runner-${action}`, `runner-${action}`]);
      assert.deepEqual(cleanup, [1, 2]);
      await tick(); await tick();
    });
  }
});

test('runner pending registration cannot qualify a retired or failed subscription and cleans returned resources exactly once', async t => {
  for (const outcome of ['retire', 'invalidate', 'rebind', 'throw', 'nonfunction']) {
    await t.test(outcome, t => {
      const { raw, runner, trace } = fixture(t);
      let saved, cleanups = 0;
      const retired = [];
      const capability = { protocol: 'pi-semantic-interrupt-v1', subscribe(handler, retire) {
        assert.equal(this, capability);
        saved = { handler, retire };
        if (outcome === 'retire') { retire('ui-reset'); retire('ui-stop'); }
        if (outcome === 'invalidate') runner.invalidate();
        if (outcome === 'rebind') runner.setUIContext(raw, 'tui');
        if (outcome === 'throw') throw new Error('raw subscribe failure');
        if (outcome === 'nonfunction') return undefined;
        return () => { cleanups++; throw new Error('cleanup failure'); };
      } };
      runner.setUIContext({ ...raw, semanticInterrupt: capability }, 'tui');
      const register = runner.getUIContext().semanticInterrupt.subscribe;
      assert.throws(() => register(() => trace.push('leak'), reason => retired.push(reason)),
        /retired|stale|disposer|raw subscribe failure/i);
      assert.equal(cleanups, ['retire', 'invalidate', 'rebind'].includes(outcome) ? 1 : 0);
      saved.handler(); saved.retire('ui-stop');
      runner.invalidate();
      assert.deepEqual(trace, []);
      const reason = { retire: 'ui-reset', invalidate: 'runner-invalidate', rebind: 'runner-rebind' }[outcome];
      assert.deepEqual(retired, reason ? [reason] : []);
      assert.equal(cleanups, reason ? 1 : 0);
    });
  }
});

test('retirement callback invalidating during rebind cannot publish a fresh binding', t => {
  const { raw, runner } = fixture(t);
  const oldUI = runner.getUIContext();
  oldUI.semanticInterrupt.subscribe(() => {}, reason => {
    assert.equal(reason, 'runner-rebind'); runner.invalidate();
  });
  assert.throws(() => runner.setUIContext(raw, 'tui'), /stale/i);
  assert.equal(runner.getUIContext(), oldUI);
  assert.throws(() => oldUI.semanticInterrupt.subscribe(() => {}, () => {}), /stale/i);
});

test('runner manual unsubscribe is silent and host retirement fences saved callbacks before notifying once', async t => {
  for (const action of ['manual', 'host']) {
    await t.test(action, t => {
      const { raw, runner, trace } = fixture(t);
      const saved = [], reasons = [];
      let cleanups = 0;
      runner.setUIContext({ ...raw, semanticInterrupt: {
        protocol: 'pi-semantic-interrupt-v1', subscribe(handler, retire) {
          saved.push({ handler, retire });
          return () => { cleanups++; handler(); retire('ui-stop'); };
        },
      } }, 'tui');
      const subscribe = runner.getUIContext().semanticInterrupt.subscribe;
      const remove = subscribe(() => trace.push('old'), reason => {
        reasons.push(reason);
        saved[0].handler();
        subscribe(() => trace.push('fresh'), () => {});
      });
      if (action === 'manual') remove(); else saved[0].retire('ui-reset');
      remove(); remove();
      saved[0].handler(); saved[0].retire('ui-stop');
      assert.deepEqual(reasons, action === 'manual' ? [] : ['ui-reset']);
      assert.deepEqual(trace, []);
      assert.equal(cleanups, 1);
      if (action === 'host') {
        saved[1].handler();
        assert.deepEqual(trace, ['fresh']);
      }
      runner.invalidate();
      assert.equal(cleanups, action === 'manual' ? 1 : 2);
    });
  }
});
