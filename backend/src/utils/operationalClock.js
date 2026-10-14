'use strict';

const DEFAULT_TIME_ZONE = 'America/Lima';

const operationalDate = (instant = new Date(), timeZone = DEFAULT_TIME_ZONE) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(instant);
  const value = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
};

const addCalendarDays = (isoDate, amount) => {
  const [year, month, day] = isoDate.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + amount));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
};

const createOperationalClock = ({ clock = () => new Date(), timeZone = DEFAULT_TIME_ZONE } = {}) => Object.freeze({
  now: () => new Date(clock()),
  datetime: () => {
    const instant = new Date(clock());
    return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(instant);
  },
  date: () => operationalDate(clock(), timeZone),
  yesterday: () => addCalendarDays(operationalDate(clock(), timeZone), -1),
  dateFor: (amount) => addCalendarDays(operationalDate(clock(), timeZone), amount),
  timeZone
});

module.exports = { DEFAULT_TIME_ZONE, operationalDate, addCalendarDays, createOperationalClock };
