import {
  expect,
  test as base,
  type Locator,
  type Page,
} from '@playwright/test';

const APP_PATH = '/app';

export const test = base.extend<{ runtimeGuard: void }>({
  runtimeGuard: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = [];

      page.on('pageerror', (error) => {
        errors.push(`pageerror: ${error.message}`);
      });
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const location = message.location();
        const source = location.url
          ? ` (${location.url}:${location.lineNumber}:${location.columnNumber})`
          : '';
        errors.push(`console.error: ${message.text()}${source}`);
      });

      await use();

      if (errors.length > 0) {
        await testInfo.attach('browser-errors', {
          body: Buffer.from(errors.join('\n')),
          contentType: 'text/plain',
        });
      }
      expect(errors, 'The browser emitted unexpected console or page errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export function saveStatus(page: Page): Locator {
  return page.getByTestId('save-status');
}

export async function waitForSaved(page: Page): Promise<void> {
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saved');
}

export async function waitForAutosave(page: Page): Promise<void> {
  await expect(saveStatus(page)).toHaveAttribute('data-state', 'saving');
  await waitForSaved(page);
}

export async function dismissGuideIfOpen(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', { name: /Skip for now/i });
  if (await dismiss.isVisible()) {
    await dismiss.click();
    await expect(dismiss).toBeHidden();
  }
}

export async function gotoApp(
  page: Page,
  options: { dismissGuide?: boolean } = {},
): Promise<void> {
  await page.goto(APP_PATH, { waitUntil: 'domcontentloaded' });
  await waitForSaved(page);
  if (options.dismissGuide ?? true) {
    await dismissGuideIfOpen(page);
  }
}

export async function createQuickNote(
  page: Page,
  note: { title: string; body: string },
): Promise<Locator> {
  await page.getByRole('button', { name: 'Quick note', exact: true }).click();

  const editor = page.getByPlaceholder('Write your note');
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  await editor.fill(note.body);
  await page.getByLabel('Page title').fill(note.title);
  await waitForAutosave(page);
  return editSelectedText(page);
}

export async function editSelectedText(page: Page): Promise<Locator> {
  const editor = page.getByPlaceholder('Write your note');
  if (await editor.isVisible()) return editor;

  const trigger = page.getByRole('button', { name: 'Edit text on page' });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  return editor;
}

export async function renameViaPrompt(
  page: Page,
  trigger: Locator,
  nextName: string,
): Promise<void> {
  const dialog = page.waitForEvent('dialog');
  const click = trigger.click();
  const prompt = await dialog;
  expect(prompt.type()).toBe('prompt');
  await prompt.accept(nextName);
  await click;
}

export async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const documentElement = document.documentElement;
    const offenders = [...document.body.querySelectorAll<HTMLElement>('*')]
      .filter((element) => {
        const rectangle = element.getBoundingClientRect();
        if (
          rectangle.width <= 0 ||
          rectangle.height <= 0 ||
          !element.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          })
        ) {
          return false;
        }
        const crossesViewport =
          rectangle.right > window.innerWidth + 1 || rectangle.left < -1;
        if (!crossesViewport) return false;

        const intentionalScrollRegion = element.closest<HTMLElement>(
          '.canvas-viewport, .editor-toolbar__scroll',
        );
        if (intentionalScrollRegion && intentionalScrollRegion !== element) {
          const scrollRectangle = intentionalScrollRegion.getBoundingClientRect();
          if (
            rectangle.right > scrollRectangle.right + 1 ||
            rectangle.left < scrollRectangle.left - 1
          ) {
            return false;
          }
        }
        return true;
      })
      .slice(0, 8)
      .map((element) => {
        const rectangle = element.getBoundingClientRect();
        return `${element.tagName.toLocaleLowerCase()}.${element.className}: ${rectangle.left.toFixed(1)}..${rectangle.right.toFixed(1)}`;
      });

    return {
      clientWidth: documentElement.clientWidth,
      scrollWidth: documentElement.scrollWidth,
      offenders,
    };
  });

  expect(
    metrics.scrollWidth,
    `Document overflowed by ${metrics.scrollWidth - metrics.clientWidth}px. Wide elements: ${metrics.offenders.join(', ')}`,
  ).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(
    metrics.offenders,
    `Visible elements crossed the viewport boundary: ${metrics.offenders.join(', ')}`,
  ).toEqual([]);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function installOneShotIndexedDbWriteFailure(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let armed = false;
    let injected = false;
    const originalPut = IDBObjectStore.prototype.put;

    IDBObjectStore.prototype.put = function (
      value: unknown,
      key?: IDBValidKey,
    ): IDBRequest<IDBValidKey> {
      if (armed && !injected && key === 'canvink:workspace:v1') {
        injected = true;
        armed = false;
        throw new DOMException(
          'Canvink E2E injected one IndexedDB write failure.',
          'QuotaExceededError',
        );
      }
      return key === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, key);
    };

    Object.defineProperty(window, '__CANVINK_E2E__', {
      configurable: false,
      value: {
        armNextIndexedDbWriteFailure() {
          armed = true;
        },
      },
    });
  });
}

export async function armOneShotIndexedDbWriteFailure(page: Page): Promise<void> {
  await page.evaluate(() => {
    const controller = (
      window as unknown as {
        __CANVINK_E2E__?: { armNextIndexedDbWriteFailure: () => void };
      }
    ).__CANVINK_E2E__;
    if (!controller) {
      throw new Error('The IndexedDB failure controller was not installed.');
    }
    controller.armNextIndexedDbWriteFailure();
  });
}
