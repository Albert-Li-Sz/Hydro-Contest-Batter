import { schoolNames } from './certificate-schools.js';
import { pinyin, surnames } from './vendor/certificate-pinyin.mjs';

export function englishSchoolName(school) {
    const key = school.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
    return schoolNames.get(key) || '';
}

// Join a given name or a compound surname, keeping the syllable boundary in names such as Xi'an.
function joinSyllables(syllables) {
    if (!syllables.length || syllables.some((s) => !/^[a-züê]+$/u.test(s))) return '';
    const word = syllables.map((s, index) => index && /^[aeo]/.test(s) ? `'${s}` : s).join('');
    return word[0].toUpperCase() + word.slice(1);
}

export function pinyinName(name) {
    const chinese = name.normalize('NFKC').replace(/\s+/gu, '');
    if (!/^\p{Script=Han}+$/u.test(chinese)) return '';
    const characters = [...chinese];
    const firstTwo = characters.slice(0, 2).join('');
    const familyLength = characters.length > 2 && surnames.has(firstTwo) ? 2 : 1;
    const family = characters.slice(0, familyLength).join('');
    const reading = surnames.get(family);
    const options = { toneType: 'none', type: 'array' };
    const familySpelling = joinSyllables(reading
        ? reading.normalize('NFD').replace(/[\u0300\u0301\u0304\u030c]/gu, '').normalize('NFC').split(' ')
        : pinyin(family, options));
    if (!familySpelling || characters.length === familyLength) return familySpelling;
    const given = joinSyllables(pinyin(characters.slice(familyLength).join(''), options));
    return given ? `${given} ${familySpelling}` : '';
}
