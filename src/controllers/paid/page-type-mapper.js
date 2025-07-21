/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
const regExRepo = {
  'cccdac43-1a22-4659-9086-b762f59b9928': [
    { name: 'homepage | Homepage', pattern: '^/[a-z]{2}/?$' },
    { name: 'blog | Reviews and Blog Content', pattern: '^/[a-z]{2}/(bulk-reviews|blog-[a-z0-9\\-]+)/?$' },
    { name: 'search | Search Results', pattern: '^/[a-z]{2}/(search|catalogsearch/result|search/go)/?$' },
    { name: 'landingpage | Goal-Based Landing Pages', pattern: '^/[a-z]{2}/(build-muscle-goal|change-your-diet-goal|perda-de-peso-2|dieta|gluten-free-diet|diet-protein-shakes)/?$' },
    { name: 'landingpage | Affiliate and Referral Programs', pattern: '^/[a-z]{2}/(programma-di-affiliazione|affiliate-programm|affiliates|programme-d-affilies|programme-de-parrainage|affiliate-scheme|affiliate-programma)/?$' },
    { name: 'landingpage | Membership and Loyalty', pattern: '^/[a-z]{2}/(boost/membership/info|mention-me/dashboard)/?$' },
    { name: 'productdetail | Product Detail Pages', pattern: '^/[a-z]{2}/(products/[a-z0-9\\-]+/[a-z0-9\\-]+(/[a-z0-9\\-]+)?|catalog/product/view/id/[0-9]+|[a-z0-9\\-]+\\.html)(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Protein Category', pattern: '^/[a-z]{2}/(protein|proteine|odzywki-bialkowe|proteinas)(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Vegan Category', pattern: '^/[a-z]{2}/vegan(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Sports Nutrition Category', pattern: '^/[a-z]{2}/(sports-nutrition|alimentazione-sportiva|sportnahrung|nutrition-sportive|sport-voeding|idrottsnutrition|sportsernaering|nutricion-deportiva|nutricao-desporto|odzywki-sportowe)(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Health Wellbeing Category', pattern: '^/[a-z]{2}/(health-wellbeing|saude-e-bem-estar|salute-e-benessere|halsa-och-valbefinnande|gesundheit-wohlbefinden|gezondheid-en-welzijn|sante-et-bien-etre|godt-helbred|salud-y-bienestar|zdrowie-i-dobre-samopoczucie)(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Vitamins Minerals Category', pattern: '^/[a-z]{2}/(vitamins|sante-et-bien-etre/multivitamins|gezondheid-en-welzijn/multivitaminen|salud-y-bienestar/multivitaminas|godt-helbred/multivitaminer)(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Food Category', pattern: '^/[a-z]{2}/(foods|nahrungsmittel|alimenti-2|livsmedel|voeding|produits-alimentaires|alimentos-saudaveis|madvarer|zywnosc|alimentacion)(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Weight Loss Category', pattern: '^/[a-z]{2}/(weight-loss|weight-loss-goal|gewichtsverlust|utrata-wagi|gewichtsafname|regime|vaegttab|viktminskning|perdita-di-peso)(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Accessories', pattern: '^/[a-z]{2}/(accessories|accessoires|zubehoer|accessori|accesorii|akcesoria|akcesoria-i-odziez|tilbehoer|tillbehoer|prislusenstvi|accessories-clothing|accessoires-en-kleding|vetements-accessoires|accessori-abbigliamento|ropa-y-accessorios|zubehor-und-bekleidung|zubehor-bekleidung|serie/accessories|selectionner-par-gamme/accessories|shoppa-via-produktutbud/accessories|shop-per-assortiment/accessories|selezione-per-gamma/accessories|shop-by-range/accessories|produktreihe/accessories|shop-efter-serie/accessories|comprar-por-gama/accessories|roupa-desportiva-e-acessorios|klader-och-tillbehor|tilbehor-toj|ropa-de-gimnasia)(/[a-z0-9\\-]+)*/?$' },
    { name: 'productlistpage | Daily Offers and Deals', pattern: '^/[a-z]{2}/(todays-offers|deal-of-the-day|offerta-del-giorno|dagens-tilbud|dagens-erbjudande|oferta-del-dia|special-sale|black-friday-rea|black-friday-sale|deal-des-tages|deal-du-jour|aanbod-van-de-dag|oferta-dnia)(-eu)?/?$' },
    { name: 'productlistpage | General Product Collections', pattern: '^/(collections|shop)/?$' },
    { name: 'productlistpage | Curated Collections and New Products', pattern: '^/[a-z]{2}/(unsere-favoriten|nouveaux-produits|nostri-preferiti|new-products|best-sellers-[a-z]{2}|vores-favoritter|vara-favoriter|nuestros-favoritos|nieuwe-producten|nuevos-productos|nuovi-prodotti|top-rated-products|de-retour-en-stock|out-stock|offerta-do-dia|geschenke-fur-veganer|saldi-black-friday|cyber-monday-rea|saffron-barker|selectionner-par-gamme|produktreihe|compare-pre-workout|first-time-orders|premiere-commande|studentenrabatt|freegift-[a-z]{2}|perda-de-peso-2/batidos-dieteticos)/?$' },
    { name: 'productlistpage | Special Promotions and Offers', pattern: '^/[a-z]{2}/(freewhey|double-[a-z]{2}|code-confirmation|code-exclusions)/?$' },
    { name: 'checkout | Cart Checkout', pattern: '^/([a-z]{2}/)*((ru/)?checkout|paypal/express/review|shop/checkout)/.*$' },
    { name: 'accountandorders | Order Tracking', pattern: '^/[a-z]{2}/trackmyorder/?$' },
    { name: 'accountandorders | My Account', pattern: '^/[a-z]{2}/(customer(/.*)?|sales/order/.*|reward/customer/.*)/?$' },
    { name: 'about | About Us', pattern: '^/[a-z]{2}/(about|sobre-nosotros|uber-uns|sobre-nos)/?$' },
    { name: 'about | Sustainability', pattern: '^/[a-z]{2}/ourplanet/?$' },
    { name: 'support | Customer Support', pattern: '^/[a-z]{2}/(contact|referafriend|recommander|invita-un-amico|student-discount|etudiants-promotions|descuentos-estudiantes|spend-save|bulk-boost|best-sellers|our-favourites|nos-favoris|onze-favorieten|a-propos-de-nous|delivery-faq|help|faq|support|contact-us|food-safety|clothing-returns)/?$' },
    { name: 'support | Email Preferences and Notifications', pattern: '^/[a-z]{2}/productalert/unsubscribe/email/product/[0-9]+/?$' },
    { name: 'support | Support Contact and Information', pattern: '^/(pages/contact|[a-z]{2}/(food-safety|clothing-returns))/?$' },
    { name: 'storelocator | Business and Wholesale', pattern: '^/(business|[a-z]{2}/wholesale)/?$' },
    { name: 'legal | Terms Conditions & Privacy Policy', pattern: '^/[a-z]{2}/(tc-exclusions|offer-terms|handelsbetingelser|impressum|privacy-policy|sitemap)(\\.html)?/?$' },
    { name: 'other | Other Pages', pattern: '.*' },
  ],
  'c236a20b-c879-4960-b5b2-c0b607ade100': [
    { name: 'homepage | Homepage', pattern: '^(/([a-z]{2}-[a-z]{2}))?/?$' },
    { name: 'productdetail | Product Detail Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/product/[a-z0-9\\-]+$' },
    { name: 'productlistpage | Category Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(tennis|baseball|softball|golf|basketball|custom|sportswear|accessories|gloves|footwear|sale|apparel|bags|protective|equipment|deals|football|volleyball|pickleball|padel|fastpitch|shoes|specialty-shops|official-partnerships)(/|$)' },
    { name: 'search | Search Results', pattern: '^(/([a-z]{2}-[a-z]{2}))?/search(\\?.*)?$' },
    { name: 'checkout | Checkout Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/checkout(/|$)' },
    { name: 'accountandorders | Login / Account / Wishlist / Order Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(login|account|register|customer|wishlist|d2x|sales)(/|$|/.*)' },
    { name: 'blog | Blog Articles', pattern: '^(/([a-z]{2}-[a-z]{2}))?/blog/.+$' },
    { name: 'blog | Blog Homepage', pattern: '^(/([a-z]{2}-[a-z]{2}))?/blog(/|$)' },
    { name: 'support | Support / Help / Warranty', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(support|warranty|contact|returns|faqs|size-guide|explore/help(/.*)?)(/|$)' },
    { name: 'legal | Legal / Terms / Privacy', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(terms|privacy|cookie-policy|accessibility|legal-notices|explore/terms-and-conditions|explore/legal)(/|$)' },
    { name: 'about | About / Brand / Company Info', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(about|careers|store-locator|explore/(about-us|careers|sportswear/our-stores|first-responders-discount|healthcare-worker-discount|tennis/wilson-athletes|football/ada-ohio-factory))(/|$)' },
    { name: 'landingpage | Promo / Campaign / Landing Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(customize|custom-builder|landing/[a-z0-9\\-]+|explore/basketball/airless-prototype|explore/forms/.*|explore/shoes/.*|explore/sportswear/lookbook)(/|$)' },
    { name: 'contentpage | Content Pages', pattern: '^(/([a-z]{2}-[a-z]{2}))?/(technology|team-dealers|partnerships|ambassadors|history|giftcard/balance)(/|$)' },
    { name: '404 | 404 Not Found', pattern: '^(/([a-z]{2}-[a-z]{2}))?/404(/|$)' },
    { name: 'other | Other Pages', pattern: '.*' },
  ],
};

export function buildPageTypeCase(siteId, column = 'path') {
  const rules = regExRepo[siteId];
export function buildPageTypeCase(siteId, column = 'path') {
  const rules = regExRepo[siteId];
  if (!rules || !rules.length) return null;

  const caseLines = [
    'CASE',
    ...rules.map(({ name, pattern }) => `    WHEN REGEXP_LIKE(${column}, '${pattern}') THEN '${name.replace(/'/g, "''")}'`),
    "    ELSE 'other | Other Pages'",
    'END AS page_type',
  ];

  return caseLines.join('\n');
}
