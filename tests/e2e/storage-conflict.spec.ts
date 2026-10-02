import { expect, gotoApp, openTopbarMore, test, waitForSaved } from "./support";

test("a second browser tab explains the writer conflict and opens after the first tab leaves", async ({
  context,
  page,
}) => {
  await gotoApp(page);
  const secondTab = await context.newPage();
  await secondTab.goto("/app", { waitUntil: "domcontentloaded" });

  const conflict = secondTab.locator(".v2-recovery");
  await expect(
    conflict.getByRole("heading", {
      name: "Wiederherstellung des Arbeitsbereichs erforderlich",
    }),
  ).toBeVisible();
  await expect(conflict.getByRole("alert")).toContainText(
    /already open in another browser tab/i,
  );
  await expect(
    conflict.getByRole("button", { name: "Geprüftes Öffnen wiederholen" }),
  ).toBeEnabled();

  await page.goto("about:blank");
  await expect
    .poll(() =>
      secondTab.evaluate(async () => {
        const snapshot = await navigator.locks.query();
        return snapshot.held.some(
          (lock) => lock.name === "canvink:workspace:v1:writer",
        );
      }),
    )
    .toBe(false);
  await conflict
    .getByRole("button", { name: "Geprüftes Öffnen wiederholen" })
    .click();
  await waitForSaved(secondTab);
  await openTopbarMore(secondTab);
  await expect(
    secondTab.getByRole("menuitem", { name: "Schnelle Notiz", exact: true }),
  ).toBeVisible();
  await secondTab.close();
});
