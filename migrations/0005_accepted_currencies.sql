-- USDT-only top-ups: accepted-coins setting (drives bot texts) + coin-aware default welcome text.
-- The coins offered on the OxaPay pay page are the ones enabled in the OxaPay Merchant Service settings.
INSERT OR IGNORE INTO settings (key, value) VALUES ('accepted_currencies', 'USDT');
-- Only replaces the welcome text if it is still the previous default (admin edits are kept).
UPDATE settings SET value = 'Get your Liveira license in seconds.' || char(10) || 'Top up with {coins} — your balance is credited automatically.'
  WHERE key = 'welcome_text' AND value = 'Get your Liveira license in seconds.' || char(10) || 'Top up with crypto — your balance is credited automatically.';
