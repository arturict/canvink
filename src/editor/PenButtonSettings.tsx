import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { useI18n } from "../i18n";
import type { TranslationKey } from "../i18n/catalog";
import {
  PEN_BUTTON_ACTIONS,
  PEN_SLOTS,
  penButtonAction,
  penSlotsPressed,
  type PenButtonAction,
  pressedButtonBits,
  type PenSlot,
} from "./penButtons";
import { setPenButtonAction, usePenButtonMapping } from "./penPreferences";

interface TestReading {
  type: string;
  contact: boolean;
  slots: PenSlot[];
  bits: number[];
  button: number;
  action: string | null;
}

/**
 * The "Stift" section of the pen menu: which action each pen button starts,
 * and a pad that reports which button the pen fires (pen models differ in how
 * they report their second barrel button).
 */
export function PenButtonSettings() {
  const { t } = useI18n();
  const mapping = usePenButtonMapping();
  const [reading, setReading] = useState<TestReading | null>(null);

  const report = (event: ReactPointerEvent<HTMLDivElement>) => {
    const input = { pointerType: event.pointerType, button: event.button, buttons: event.buttons };
    const action = penButtonAction(input, mapping);
    const next: TestReading = {
      type: event.pointerType,
      contact: (event.buttons & 1) !== 0,
      slots: penSlotsPressed(input),
      bits: pressedButtonBits(event.buttons),
      button: event.button,
      action,
    };
    setReading((current) => (
      current
      && current.type === next.type
      && current.contact === next.contact
      && current.bits.join() === next.bits.join()
      && current.button === next.button
        ? current
        : next
    ));
  };

  const typeLabel = (type: string) => (type === "pen" ? t("canvas.pen.barrel") : type);
  const slotLabel = (slot: PenSlot) => t(`canvas.pen.slot.${slot}` as TranslationKey);
  const actionLabel = (action: string) => t(`canvas.pen.action.${action}` as TranslationKey);

  return (
    <div className="pen-buttons" role="group" aria-label={t("canvas.pen.barrel")} title={t("canvas.pen.barrelHint")}>
      <p className="ribbon-popover__heading">{t("canvas.pen.barrel")}</p>
      {PEN_SLOTS.map((slot) => (
        <label key={slot} className="pen-buttons__row">
          <span>{slotLabel(slot)}</span>
          <select
            value={mapping[slot]}
            data-pen-slot={slot}
            onChange={(event) => setPenButtonAction(slot, event.currentTarget.value as PenButtonAction)}
          >
            {PEN_BUTTON_ACTIONS.map((action) => (
              <option key={action} value={action}>{actionLabel(action)}</option>
            ))}
          </select>
        </label>
      ))}
      <div
        className="pen-buttons__pad"
        data-pen-test-pad="true"
        onPointerDown={report}
        onPointerMove={report}
        onPointerUp={report}
        onContextMenu={(event) => event.preventDefault()}
      >
        <strong>{t("canvas.pen.test")}</strong>
        <span>{t("canvas.pen.testPad")}</span>
        <output data-pen-test-result="true" aria-live="polite">
          {reading
            ? [
                typeLabel(reading.type),
                reading.contact ? t("canvas.pen.testContact") : t("canvas.pen.testHover"),
                (reading.slots.length > 0
                  ? reading.slots.map((slot) => slotLabel(slot)).join(" + ")
                  : t("canvas.pen.testNoButton"))
                  + (reading.action ? ` → ${actionLabel(reading.action)}` : ""),
                t("canvas.pen.testUnknownBits", { bits: reading.bits.join("+") || "0", button: reading.button }),
              ].filter(Boolean).join(" · ")
            : t("canvas.pen.testIdle")}
        </output>
      </div>
    </div>
  );
}
