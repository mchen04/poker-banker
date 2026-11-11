import { expect, type Locator } from '@playwright/test';

export async function typeInput(field: Locator, value: string, options: { append?: boolean; expectedValue?: string } = {}) {
  const shape = await field.evaluate(element => ({
    type: element instanceof HTMLInputElement ? element.type : element instanceof HTMLTextAreaElement ? 'textarea' : element.tagName.toLowerCase(),
    locale: navigator.language,
  }));
  const segmented = shape.type === 'date' || shape.type === 'datetime-local';
  expect(segmented || ['text', 'password', 'search', 'email', 'url', 'tel', 'number', 'textarea'].includes(shape.type), 'Physical keyboard entry requires a typed input or textarea').toBe(true);
  const keyboard = field.page().keyboard;
  const expected = options.expectedValue ?? (options.append ? await field.inputValue() + value : value);
  if (segmented) {
    expect(options.append, 'Native date fields require a complete ISO value').not.toBe(true);
    expect(shape.locale, 'Native date keyboard entry requires the configured en-US locale').toBe('en-US');
    if (value === '') {
      const count = shape.type === 'date' ? 3 : 7;
      await field.click();
      for (let index = 0; index < count; index++) {
        for (let position = 0; position < count; position++) await keyboard.press('ArrowLeft');
        for (let position = 0; position < index; position++) await keyboard.press('ArrowRight');
        await keyboard.press('Delete');
      }
      expect(await field.inputValue() === '', 'Native date keyboard entry must clear every segment').toBe(true);
      return;
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
    expect(!!match, 'Native date keyboard entry requires an ISO date or datetime').toBe(true);
    const [, year, month, day, hour, minute, second] = match!;
    const segments = [month!, day!, year!];
    if (shape.type === 'datetime-local') {
      expect(hour !== undefined, 'Native datetime keyboard entry requires a time').toBe(true);
      segments.push(String(Number(hour) % 12 || 12).padStart(2, '0'), minute!, second ?? '00', Number(hour) < 12 ? 'a' : 'p');
    }
    await field.click();
    for (const [index, segment] of segments.entries()) {
      for (let position = 0; position < segments.length; position++) await keyboard.press('ArrowLeft');
      for (let position = 0; position < index; position++) await keyboard.press('ArrowRight');
      await keyboard.press('Delete');
      if (segment === 'a' || segment === 'p') {
        await keyboard.press('ArrowDown');
        if (segment === 'a') await keyboard.press('ArrowUp');
      } else {
        await keyboard.type(segment);
      }
    }
    const normalized = shape.type === 'datetime-local' && value.endsWith(':00') && value.length === 19 ? value.slice(0, -3) : value;
    expect(await field.inputValue() === normalized, 'Native date keyboard entry must retain the complete requested value').toBe(true);
    return;
  }
  await field.click();
  await keyboard.press('ControlOrMeta+A');
  if (options.append) {
    await keyboard.press('ArrowRight');
  } else {
    await keyboard.press('Backspace');
  }
  await keyboard.type(value);
  if (options.expectedValue !== undefined) await expect(field).toHaveValue(expected);
  else expect(await field.inputValue() === expected, 'Physical keyboard entry must retain the complete requested value').toBe(true);
}
