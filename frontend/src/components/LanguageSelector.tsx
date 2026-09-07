'use client';

import { Languages } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';

export function LanguageSelector() {
  const { language, setLanguage, t } = useLanguage();

  return (
    <div className="flex items-center gap-1" aria-label={t('common.language')}>
      <Languages className="h-4 w-4 text-muted-foreground" />
      <Button
        type="button"
        variant={language === 'en' ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => setLanguage('en')}
        aria-pressed={language === 'en'}
      >
        EN
      </Button>
      <Button
        type="button"
        variant={language === 'es' ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => setLanguage('es')}
        aria-pressed={language === 'es'}
      >
        ES
      </Button>
    </div>
  );
}
