export function businessDate(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (name: string) => {
    const found = parts.find((item) => item.type === name);
    if (!found) throw new Error('Calendar date could not be formatted');
    return found.value;
  };
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function databaseDate(value: string): Date {
  return new Date(value + 'T00:00:00.000Z');
}

/**
 * Converts a local calendar date ("YYYY-MM-DD") and local time ("HH:mm")
 * in a given IANA timezone into a UTC Date object.
 */
export function localTimeToUtc(
  dateStr: string,
  timeStr: string,
  timeZone: string,
): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hours, minutes, seconds = 0] = timeStr.split(':').map(Number);
  const targetUtc = Date.UTC(year, month - 1, day, hours, minutes, seconds);

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });

  let estimateUtc = targetUtc;
  for (let i = 0; i < 3; i++) {
    const parts = formatter
      .formatToParts(new Date(estimateUtc))
      .reduce<Record<string, string>>((acc, p) => {
        acc[p.type] = p.value;
        return acc;
      }, {});
    const h = parts.hour === '24' ? 0 : Number(parts.hour);
    const formattedAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      h,
      Number(parts.minute),
      Number(parts.second),
    );
    const diff = formattedAsUtc - targetUtc;
    if (diff === 0) break;
    estimateUtc -= diff;
  }
  return new Date(estimateUtc);
}

/**
 * Formats a UTC Date to "HH:mm" in the given IANA timezone.
 */
export function utcToLocalTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const min = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour}:${min}`;
}

