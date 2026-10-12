import { describe, expect, it } from 'vitest';
import { getTranslation } from '@/i18n/dict';

describe('Spanish UI text encoding', () => {
  it('keeps common labels as valid Unicode through translation lookup and JSON round-trip', () => {
    const labels = [
      getTranslation('es', 'dashboard.periodMode'),
      getTranslation('es', 'dashboard.latestPeriod'),
      getTranslation('es', 'reports.period'),
      getTranslation('es', 'reports.periodBreakdown'),
      'información configuración predicción transacción notificación último ítem niño año señal José S/ 17.61 ¿ ¡'
    ];

    const decoded = JSON.parse(JSON.stringify(labels)) as string[];
    expect(decoded).toEqual(labels);
    expect(decoded.join(' ')).toContain('Período');
    expect(decoded.join(' ')).toContain('Último período');
    expect(decoded.join(' ')).toContain('información');
    expect(decoded.join(' ')).toContain('José');
  });
});
