import { getDictionary, type SupportedLang } from "./i18n";

export function browserErrorMessage(code: unknown, lang: SupportedLang): string {
  const dict = getDictionary(lang);
  return typeof code === "string" && Object.hasOwn(dict.browserErrors, code)
    ? dict.browserErrors[code as keyof typeof dict.browserErrors]
    : dict.security.scriptGenericError;
}

// Use stable public codes, never upstream prose, in the browser's chosen language.
export const BROWSER_ERROR_SCRIPT = `
function browserErrorMessage(error) {
  return t('browserError_' + (typeof error?.code === 'string' ? error.code : ''), t('scriptGenericError'));
}
`;
