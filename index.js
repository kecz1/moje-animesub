const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

// Zmienna globalna dla BASE_URL - ustawiana przy starcie serwera
let BASE_URL_RESOLVED = '';
// PREFER_ASS=1: napisy ASS/SSA są wysyłane do Stremio w oryginale (z pozycjami i stylami), bez konwersji do SRT.
// Wymaga włączonej opcji "Style ASS subtitles" w ustawieniach odtwarzacza Stremio.
const PREFER_ASS = process.env.PREFER_ASS === '1';
const LOCAL_SUBS_DIR = path.join(__dirname, 'my-subs');

if (!fs.existsSync(LOCAL_SUBS_DIR)) {
    fs.mkdirSync(LOCAL_SUBS_DIR, { recursive: true });
    console.log(`[Init] Created local subtitles folder: ${LOCAL_SUBS_DIR}`);
}

/** * Konwertuje czas SRT na milisekundy (przydatne do filtrowania i cięcia) 
 */
function srtTimeToMs(srtTime) {
    const match = srtTime.match(/(\d+):(\d{2}):(\d{2}),(\d{3})/);
    if (!match) return 0;
    return parseInt(match[1], 10) * 3600000 +
           parseInt(match[2], 10) * 60000 +
           parseInt(match[3], 10) * 1000 +
           parseInt(match[4], 10);
}

/** * Konwertuje milisekundy na format czasu SRT 
 */
function formatSrtTime(ms) {
    const hours = Math.floor(ms / 3600000).toString().padStart(2, '0');
    const minutes = Math.floor((ms % 3600000) / 60000).toString().padStart(2, '0');
    const seconds = Math.floor((ms % 60000) / 1000).toString().padStart(2, '0');
    const milliseconds = (ms % 1000).toString().padStart(3, '0');
    return `${hours}:${minutes}:${seconds},${milliseconds}`;
}

/** * Konwertuje polskie formaty TXT (MicroDVD, MPL2, TMPlayer) do SRT 
 */
function convertTxtToSrt(textContent) {
    const lines = textContent.split(/\r?\n/);
    // Jeśli plik to już SRT (tylko ze złym rozszerzeniem .txt)
    if (lines.some(l => l.includes('-->'))) {
        return textContent;
    }
    let srt = '';
    let counter = 1;
    const fps = 23.976; // Domyślny FPS dla anime

    // 1. Sprawdzenie czy to format TMPlayer (GG:MM:SS:Tekst)
    const isTMPlayer = lines.some(l => l.match(/^\d{2}:\d{2}:\d{2}:/));
    if (isTMPlayer) {
        const parsedLines = [];
        for (let line of lines) {
            line = line.trim();
            if (!line) continue;
            // Dopasowuje HH:MM:SS:Tekst
            const match = line.match(/^(\d{2}):(\d{2}):(\d{2}):(.*)/);
            if (match) {
                const hours = match[1];
                const minutes = match[2];
                const seconds = match[3];
                let text = match[4].replace(/\|/g, '\n');
                const timeSrtFormat = `${hours}:${minutes}:${seconds},000`;
                const timeInSeconds = parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds);
                parsedLines.push({ timeStr: timeSrtFormat, timeSec: timeInSeconds, text: text });
            } else if (parsedLines.length > 0) {
                // Sklejanie linii bez czasu z poprzednim napisem (usuwa znak '|' na początku jeśli jest)
                parsedLines[parsedLines.length - 1].text += '\n' + line.replace(/^\|/, '');
            }
        }
        // Generowanie SRT z obliczonym czasem końcowym
        for (let i = 0; i < parsedLines.length; i++) {
            const current = parsedLines[i];
            let endTimeStr;
            if (i < parsedLines.length - 1) {
                const next = parsedLines[i + 1];
                const diff = next.timeSec - current.timeSec;
                if (diff <= 4 && diff > 0) {
                    endTimeStr = next.timeStr;
                } else {
                    let endSec = current.timeSec + 4;
                    const h = Math.floor(endSec / 3600).toString().padStart(2, '0');
                    const m = Math.floor((endSec % 3600) / 60).toString().padStart(2, '0');
                    const s = Math.floor(endSec % 60).toString().padStart(2, '0');
                    endTimeStr = `${h}:${m}:${s},000`;
                }
            } else {
                let endSec = current.timeSec + 4;
                const h = Math.floor(endSec / 3600).toString().padStart(2, '0');
                const m = Math.floor((endSec % 3600) / 60).toString().padStart(2, '0');
                const s = Math.floor(endSec % 60).toString().padStart(2, '0');
                endTimeStr = `${h}:${m}:${s},000`;
            }
            srt += `${counter++}\n${current.timeStr} --> ${endTimeStr}\n${current.text}\n\n`;
        }
        return srt.length > 0 ? srt.trim() : textContent;
    }

    // 2. Obsługa starych formatów (MPL2 / MicroDVD)
    const parsedOther = [];
    for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        // Format MPL2: [123][456]Tekst
        const mplMatch = line.match(/^\[(\d+)\]\[(\d+)\](.*)/);
        if (mplMatch) {
            const startMs = parseInt(mplMatch[1], 10) * 100;
            const endMs = parseInt(mplMatch[2], 10) * 100;
            let text = mplMatch[3].replace(/\|/g, '\n');
            parsedOther.push({ startMs, endMs, text });
            continue;
        }
        // Format MicroDVD: {123}{456}Tekst
        const mdvdMatch = line.match(/^\{(\d+)\}\{(\d+)\}(.*)/);
        if (mdvdMatch) {
            const startMs = Math.round((parseInt(mdvdMatch[1], 10) / fps) * 1000);
            const endMs = Math.round((parseInt(mdvdMatch[2], 10) / fps) * 1000);
            let text = mdvdMatch[3].replace(/\|/g, '\n');
            parsedOther.push({ startMs, endMs, text });
            continue;
        }
        // Jeśli linia nie ma znaczników, a mamy już jakiś napis w buforze
        if (parsedOther.length > 0) {
            parsedOther[parsedOther.length - 1].text += '\n' + line.replace(/^\|/, '');
        }
    }
    for (let sub of parsedOther) {
        srt += `${counter++}\n${formatSrtTime(sub.startMs)} --> ${formatSrtTime(sub.endMs)}\n${sub.text}\n\n`;
    }
    return srt.length > 0 ? srt.trim() : textContent;
}

/** * Konwertuje czas ASS (H:MM:SS.cc) na format SRT (HH:MM:SS,mmm) 
 */
function assTimeToSrt(assTime) {
    const match = assTime.match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/);
    if (!match) return '00:00:00,000';
    const hours = match[1].padStart(2, '0');
    const minutes = match[2];
    const seconds = match[3];
    const centis = match[4];
    const millis = (parseInt(centis, 10) * 10).toString().padStart(3, '0');
    return `${hours}:${minutes}:${seconds},${millis}`;
}

/** * Usuwa tagi ASS z tekstu (np. {\i1}, {\b1}, {\pos(x,y)}, itp.) 
 */
function stripAssTags(text) {
    let result = text.replace(/\{[^}]*\}/g, '');
    result = result.replace(/\\N/g, '\n');
    result = result.replace(/\\n/g, '\n');
    result = result.replace(/\\h/g, ' ');
    return result.trim();
}

/** * Oblicza podobieństwo dwóch tekstów używając Odległości Levenshteina. 
 */
function calculateSimilarity(str1, str2) {
    const a = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
    const b = str2.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (a.length === 0 || b.length === 0) return 0;
    if (a === b) return 1;
    const matrix = Array(a.length + 1).fill(null).map(() => Array(b.length + 1).fill(null));
    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i][j - 1] + 1,
                matrix[i - 1][j] + 1,
                matrix[i - 1][j - 1] + indicator
            );
        }
    }
    const distance = matrix[a.length][b.length];
    const maxLength = Math.max(a.length, b.length);
    return (maxLength - distance) / maxLength;
}

/** Czy wyrównanie ASS (numer) oznacza górę ekranu. SSA (V4) używa innej numeracji niż ASS (V4+). */
function isTopAlignment(n, isSsa) {
    if (!n) return false;
    return isSsa ? (n >= 5 && n <= 8) : (n >= 7 && n <= 9);
}

/** Zamienia tagi ASS na tekst SRT: zostawia tylko kursywę, resztę usuwa */
function assTextToSrtText(rawText) {
    let italicOpen = false;
    let text = rawText.replace(/\{[^}]*\}/g, block => {
        const m = block.match(/\\i([01])(?![0-9a-z])/gi);
        if (m) {
            const last = m[m.length - 1].endsWith('1');
            if (last && !italicOpen) { italicOpen = true; return '<i>'; }
            if (!last && italicOpen) { italicOpen = false; return '</i>'; }
        }
        return '';
    });
    if (italicOpen) text += '</i>';
    text = text.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
    return text.split('\n').map(l => l.trim()).filter(Boolean).join('\n').trim();
}

/**
 * Konwertuje napisy ASS/SSA do SRT, tak żeby dało się je czytać w odtwarzaczach bez obsługi ASS:
 *  - wyrzuca napisy "na ekranie" (typesetting: \pos/\move, style Sign/Title/OP/ED, rysunki, karaoke),
 *    które w SRT zamieniają się w wielki słup tekstu,
 *  - zostawia same dialogi i łączy nakładające się w jeden blok (bez skakania góra/dół),
 *  - linie z góry ekranu (\an7-9 lub styl z wyrównaniem na górze) idą w bloku wyżej, zawsze w tej samej kolejności,
 *  - zachowuje kursywę (<i>).
 */
function convertAssToSrt(assContent, opts = {}) {
    const MAX_LINES = opts.maxLines || 4;
    const lines = assContent.replace(/\r/g, '').replace(/^\uFEFF/, '').split('\n');
    let section = '';
    let eventFormat = [];
    let styleFormat = [];
    const styleTop = {};
    const dialogues = [];
    let order = 0;
    let playResY = 288; // domyślna wartość z libass, gdy plik nie podaje PlayResY

    const SIGN_STYLE = /sign|typeset|title|credit|eyecatch|logo|screen|note|caption|karaoke|lyric|romaji|kanji|insert|^(op|ed)\b|[ _-](op|ed)\b|\b(op|ed)[ _-]?\d*$/i;
    const DIALOG_STYLE = /^(default|main|italic|top|narrat|thought|dialog|overlap|flashback|text|speech|internal|radio|phone|tv)/i;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('[')) { section = line.toLowerCase(); continue; }
        const lower = line.toLowerCase();

        if (section.includes('styles')) {
            const isSsa = !section.includes('v4+');
            if (lower.startsWith('format:')) {
                styleFormat = line.substring(7).split(',').map(f => f.trim().toLowerCase());
            } else if (lower.startsWith('style:')) {
                const parts = line.substring(6).split(',').map(x => x.trim());
                const ni = styleFormat.indexOf('name');
                const ai = styleFormat.indexOf('alignment');
                if (ni !== -1 && ai !== -1) styleTop[parts[ni]] = isTopAlignment(parseInt(parts[ai], 10), isSsa);
            }
            continue;
        }
        if (section.includes('script info')) {
            if (lower.startsWith('playresy:')) playResY = parseInt(line.substring(9), 10) || playResY;
            continue;
        }
        if (!section.includes('events')) continue;

        if (lower.startsWith('format:')) {
            eventFormat = line.substring(7).split(',').map(f => f.trim().toLowerCase());
            continue;
        }
        if (!lower.startsWith('dialogue:')) continue;

        const dialogueStr = line.substring(9).trim();
        const parts = [];
        let current = '';
        for (let i = 0; i < dialogueStr.length; i++) {
            const ch = dialogueStr[i];
            if (ch === ',' && parts.length < eventFormat.length - 1) {
                parts.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }
        parts.push(current.trim());

        const startIdx = eventFormat.indexOf('start');
        const endIdx = eventFormat.indexOf('end');
        const textIdx = eventFormat.indexOf('text');
        const styleIdx = eventFormat.indexOf('style');
        if (startIdx === -1 || endIdx === -1 || textIdx === -1) continue;
        if (parts.length <= Math.max(startIdx, endIdx, textIdx)) continue;

        const rawText = parts[textIdx];
        const styleName = styleIdx !== -1 ? parts[styleIdx] : '';

        // Rysunki wektorowe (\p1...) i karaoke (wiele \k) - nieczytelne w SRT
        if (/\\p[1-9](?![0-9a-z])/i.test(rawText)) continue;
        if ((rawText.match(/\\k[fo]?\d+/gi) || []).length >= 3) continue;

        // Typesetting: napisy "przyklejone" do miejsca na ekranie
        const hasPos = /\\(pos|move)\s*\(/i.test(rawText);
        if (SIGN_STYLE.test(styleName)) continue;
        if (/\\move\s*\(/i.test(rawText)) continue; // animowane napisy na ekranie
        if (hasPos) {
            if (!DIALOG_STYLE.test(styleName)) continue;
            // \pos w górnej części kadru = napis w scenie, nie dialog
            const pm = rawText.match(/\\pos\s*\(\s*-?[\d.]+\s*,\s*(-?[\d.]+)/i);
            if (pm && parseFloat(pm[1]) / playResY < 0.55) continue;
        }

        const text = assTextToSrtText(rawText);
        if (!text) continue;
        if (/^[ml]\s+-?[\d.]+\s+-?[\d.]+/i.test(text)) continue;

        const startMs = srtTimeToMs(assTimeToSrt(parts[startIdx]));
        const endMs = srtTimeToMs(assTimeToSrt(parts[endIdx]));
        if (endMs <= startMs) continue;
        if (endMs - startMs > 60000) continue; // znaki wodne

        const an = rawText.match(/\\an([1-9])/i);
        const top = an ? parseInt(an[1], 10) >= 7 : !!styleTop[styleName];

        dialogues.push({ startMs, endMs, text, top, order: order++ });
    }

    // Cięcie osi czasu: jeden blok = jeden zestaw aktywnych linii
    const timePoints = new Set();
    dialogues.forEach(d => { timePoints.add(d.startMs); timePoints.add(d.endMs); });
    const sortedTimes = Array.from(timePoints).sort((x, y) => x - y);
    const blocks = [];

    for (let i = 0; i < sortedTimes.length - 1; i++) {
        const start = sortedTimes[i];
        const end = sortedTimes[i + 1];
        if (start === end) continue;

        const active = dialogues
            .filter(d => d.startMs <= start && d.endMs >= end)
            // góra ekranu najpierw, potem dół; w grupie wg czasu startu i kolejności w pliku
            .sort((x, y) => (y.top - x.top) || (x.startMs - y.startMs) || (x.order - y.order));
        if (!active.length) continue;

        const texts = [...new Set(active.map(d => d.text))].slice(0, MAX_LINES);
        blocks.push({ startMs: start, endMs: end, text: texts.join('\n') });
    }

    // Scalanie sąsiednich identycznych bloków i wygładzanie mikro-przeskoków (<120 ms)
    const merged = [];
    for (const block of blocks) {
        const last = merged[merged.length - 1];
        if (last && last.endMs === block.startMs) {
            if (last.text === block.text) { last.endMs = block.endMs; continue; }
            if (block.endMs - block.startMs < 120) { last.endMs = block.endMs; continue; }
        }
        merged.push({ ...block });
    }

    return merged
        .map((d, i) => `${i + 1}\n${formatSrtTime(d.startMs)} --> ${formatSrtTime(d.endMs)}\n${d.text}`)
        .join('\n\n');
}

// Konfiguracja
const BASE_URL = 'http://animesub.info';
const SEARCH_URL = `${BASE_URL}/szukaj.php`;
const DOWNLOAD_URL = `${BASE_URL}/sciagnij.php`;

// Manifest wtyczki
const manifest = {
    id: 'community.animesub.info',
    version: '1.1.0',
    name: 'Polskie napisy do anime (fansuby + AnimeSub.info)',
    description: 'Polskie napisy do anime z fansuby.cc oraz animesub.info',
    logo: 'https://i.imgur.com/qKLYVZx.png',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'kitsu'],
    catalogs: [],
    behaviorHints: {
        configurable: false,
        configurationRequired: false
    }
};

const builder = new addonBuilder(manifest);
const session = axios.create({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Charset': 'ISO-8859-2,utf-8;q=0.7,*;q=0.3',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pl,en;q=0.9'
    },
    responseType: 'arraybuffer',
    timeout: 15000
});

const searchCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

async function getMetaInfo(type, id) {
    const parts = id.split(':');
    const prefix = parts[0];
    let season = null;
    let episode = null;
    let title = null;
    let year = null;
    
    if (prefix === 'kitsu') {
        const kitsuId = parts[1];
        episode = parts.length >= 3 ? parseInt(parts[2], 10) : null;
        season = 1;
        try {
            const kitsuUrl = `https://kitsu.io/api/edge/anime/${kitsuId}`;
            const response = await axios.get(kitsuUrl, {
                headers: {
                    'Accept': 'application/vnd.api+json',
                    'Content-Type': 'application/vnd.api+json'
                },
                timeout: 5000
            });
            const anime = response.data.data.attributes;
            title = anime.titles?.en_jp || anime.canonicalTitle || anime.titles?.ja_jp || anime.titles?.en;
            year = anime.startDate ? parseInt(anime.startDate.substring(0, 4), 10) : null;
            console.log(`[Kitsu] Pobrano: "${title}" (${year})`);
        } catch (error) {
            console.error('[Kitsu] Błąd pobierania metadanych:', error.message);
        }
        return { title, year, season, episode, kitsuId };
    } else {
        const imdbId = parts[0];
        if (type === 'series' && parts.length >= 3) {
            season = parseInt(parts[1], 10);
            episode = parseInt(parts[2], 10);
        }
        try {
            const metaUrl = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
            const response = await axios.get(metaUrl, { timeout: 5000 });
            const meta = response.data.meta;
            return {
                title: meta.name,
                year: meta.year,
                season,
                episode,
                imdbId
            };
        } catch (error) {
            console.error('Błąd pobierania metadanych z Cinemeta:', error.message);
            return { imdbId, season, episode, title: null, year: null };
        }
    }
}

async function searchSubtitles(title, titleType = 'en') {
    const cacheKey = `${title}:${titleType}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`[Cache hit] ${title}`);
        return cached.results;
    }
    console.log(`\n[Szukanie animesub.info] query: "${title}", type: "${titleType}"`);
    try {
        const response = await session.get(SEARCH_URL, {
            params: {
                szukane: title,
                pTitle: titleType
            }
        });
        const html = iconv.decode(Buffer.from(response.data), 'ISO-8859-2');
        const results = parseSearchResults(html);
        searchCache.set(cacheKey, { results, timestamp: Date.now() });
        console.log(`[Znaleziono] ${results.length} wyników dla "${title}"`);
        return results;
    } catch (error) {
        console.error('Błąd wyszukiwania:', error.message);
        return [];
    }
}

function parseSearchResults(html) {
    const $ = cheerio.load(html);
    const subtitles = [];
    $('table.Napisy[style*="text-align:center"]').each((i, table) => {
        try {
            const rows = $(table).find('tr.KNap');
            if (rows.length < 3) return;
            const row1Cells = $(rows[0]).find('td');
            const titleOrg = $(row1Cells[0]).text().trim();
            const formatType = $(row1Cells[3]).text().trim();
            const row2Cells = $(rows[1]).find('td');
            const titleEng = $(row2Cells[0]).text().trim();
            const author = $(row2Cells[1]).find('a').text().trim() || $(row2Cells[1]).text().trim().replace(/^~/, '');
            const row3Cells = $(rows[2]).find('td');
            const titleAlt = $(row3Cells[0]).text().trim();
            let downloadCount = 0;
            if (row3Cells.length > 3) {
                const countText = $(row3Cells[3]).text().trim();
                downloadCount = parseInt(countText.split(' ')[0], 10) || 0;
            }
            const downloadRow = $(table).find('tr.KKom');
            const form = downloadRow.find('form[method="POST"]');
            const subtitleId = form.find('input[name="id"]').val();
            const downloadHash = form.find('input[name="sh"]').val();
            const description = downloadRow.find('td.KNap[align="left"]').text().trim();
            if (!subtitleId || !downloadHash) return;
            const episodeInfo = parseEpisodeInfo(titleOrg, titleEng, titleAlt, description);
            subtitles.push({
                id: subtitleId,
                hash: downloadHash,
                titleOrg,
                titleEng,
                titleAlt,
                author,
                formatType,
                downloadCount,
                description,
                ...episodeInfo
            });
        } catch (error) {
            console.error('Błąd parsowania wiersza:', error.message);
        }
    });
    return subtitles;
}

function parseEpisodeInfo(titleOrg, titleEng, titleAlt, description) {
    let season = null;
    let episode = null;
    let epStart = null;
    let epEnd = null;
    const texts = [titleOrg, titleEng, titleAlt, description].filter(Boolean);
    
    // 1. Sprawdzanie sezonu
    for (const text of texts) {
        if (season === null) {
            const seasonMatch = text.match(/(?:Season|Sezon|S|Part)\s*\.?\s*(\d+)|(\d+)(?:nd|rd|th)\s+(?:Season|Sezon)/i);
            if (seasonMatch) {
                season = parseInt(seasonMatch[1] || seasonMatch[2], 10);
            }
        }
    }
    if (season === null) {
        const titles = [titleOrg, titleEng, titleAlt].filter(Boolean);
        for (const title of titles) {
            const romanMatch = title.match(/\b(II|III|IV|V|VI)\b/i);
            if (romanMatch) {
                const romanToNum = { 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5, 'vi': 6 };
                season = romanToNum[romanMatch[1].toLowerCase()];
                break;
            }
        }
    }
    
    // 2. Szukanie paczek
    for (const text of texts) {
        if (epStart === null) {
            const rangeMatch = text.match(/(?:ep|odc|odcinki)?\s*\.?\s*(\d{1,3})\s*(?:-|~|do)\s*(\d{1,3})(?:\s|-|_|\]|\)|$)/i);
            if (rangeMatch) {
                const start = parseInt(rangeMatch[1], 10);
                const end = parseInt(rangeMatch[2], 10);
                if (start < end && end - start < 1000 && start !== 720 && end !== 1080) {
                    epStart = start;
                    epEnd = end;
                    episode = start;
                    break;
                }
            }
        }
    }
    
    // 3. Szukanie pojedynczego odcinka
    if (epStart === null) {
        for (const text of texts) {
            if (episode === null) {
                const epMatch = text.match(/(?:ep|episode|odc|odcinek)\s*\.?\s*(\d+)/i);
                if (epMatch) {
                    episode = parseInt(epMatch[1], 10);
                }
            }
        }
        if (episode === null) {
            for (const text of texts) {
                const fallbackMatch = text.match(/(?:\s|-|_|\[|\(|\.)(\d{1,3})(?:\s|-|_|\]|\)|v\d|$)/i);
                if (fallbackMatch) {
                    const parsedEp = parseInt(fallbackMatch[1], 10);
                    if (parsedEp !== 720 && parsedEp !== 480 && (parsedEp < 1900 || parsedEp > 2100)) {
                        episode = parsedEp;
                        break;
                    }
                }
            }
        }
    }
    return { season, episode, epStart, epEnd };
}

function generateSearchStrategies(title, season, episode) {
    const strategies = [];
    let fullWithSpace = title.replace(/:/g, ' ').replace(/[^a-zA-Z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
    let leftSide = title.split(':')[0].replace(/[^a-zA-Z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
    let rightSide = "";
    if (title.includes(':')) {
        rightSide = title.split(':').slice(1).join(' ').replace(/[^a-zA-Z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
    }
    const nameVariants = [fullWithSpace, leftSide];
    if (rightSide && rightSide.length > 3) nameVariants.push(rightSide);
    
    let epPad = episode !== null ? episode.toString().padStart(2, '0') : '';
    for (const name of nameVariants) {
        if (episode !== null) {
            if (season && season > 1) {
                strategies.push({ type: 'en', query: `${name} ${season} ep${epPad}` });
                strategies.push({ type: 'en', query: `${name} Season ${season} ep${epPad}` });
            }
            strategies.push({ type: 'en', query: `${name} ep${epPad}` });
            if (season && season > 1) {
                strategies.push({ type: 'org', query: `${name} ${season} ep${epPad}` });
            }
            strategies.push({ type: 'org', query: `${name} ep${epPad}` });
        }
    }
    for (const name of nameVariants) {
        if (season && season > 1) {
            strategies.push({ type: 'en', query: `${name} ${season}` });
            strategies.push({ type: 'en', query: `${name} Season ${season}` });
        }
    }
    strategies.push({ type: 'en', query: leftSide });
    return strategies;
}

function matchSubtitles(subtitles, targetSeason, targetEpisode, targetTitle) {
    const targetParts = targetTitle.split(':').map(p => p.toLowerCase().replace(/[^a-z0-9]/g, ''));
    const cleanTargetFull = targetTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
    const targetsToCompare = [cleanTargetFull, ...targetParts].filter(p => p.length > 2);
    
    return subtitles.filter(sub => {
        // 1. PORÓWNYWANIE TYTUŁÓW
        const titlesToCompare = [sub.titleOrg, sub.titleEng, sub.titleAlt].filter(Boolean);
        let isTitleMatch = false;
        for (const t of titlesToCompare) {
            const cleanT = t.toLowerCase().replace(/[^a-z0-9]/g, '');
            for (const target of targetsToCompare) {
                const similarity = calculateSimilarity(target, cleanT);
                if (similarity >= 0.6 || cleanT.includes(target) || target.includes(cleanT)) {
                    isTitleMatch = true;
                    break;
                }
            }
            if (isTitleMatch) break;
        }
        if (!isTitleMatch) return false;
        
        // 2. RYGORYSTYCZNY FILTR SEZONÓW
        if (targetSeason !== null) {
            if (sub.season !== null && sub.season !== targetSeason) return false;
            if (targetSeason > 1 && sub.season === null) return false;
        }
        
        // 3. FILTR ODCINKÓW
        if (targetEpisode !== null) {
            if (sub.epStart !== null && sub.epEnd !== null) {
                if (targetEpisode < sub.epStart || targetEpisode > sub.epEnd) return false;
            } else if (sub.episode !== null && sub.episode !== targetEpisode) {
                return false;
            }
        }
        return true;
    });
}

function createSubtitleUrl(subtitle, searchQuery, searchType, episode) {
    const params = new URLSearchParams({
        id: subtitle.id,
        hash: subtitle.hash,
        query: searchQuery,
        type: searchType
    });
    if (episode !== null && episode !== undefined) {
        params.append('episode', episode);
    }
    // Przy PREFER_ASS Stremio rozpoznaje ASS po rozszerzeniu w ścieżce URL
    let pathExt = '';
    if (PREFER_ASS) {
        const fmt = String(subtitle.formatType || '');
        if (/\bssa\b/i.test(fmt)) pathExt = `/${subtitle.id}.ssa`;
        else if (/\bass\b/i.test(fmt)) pathExt = `/${subtitle.id}.ass`;
    }
    return `${BASE_URL_RESOLVED}/subtitles/download${pathExt}?${params.toString()}`;
}

function findLocalSubtitle(title, season, episode) {
    if (!fs.existsSync(LOCAL_SUBS_DIR)) return null;
    const files = fs.readdirSync(LOCAL_SUBS_DIR);
    const cleanTargetTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
    const titleWords = title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    
    for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (!['.srt', '.ass', '.ssa', '.txt', '.sub'].includes(ext)) continue;
        const cleanFile = file.toLowerCase().replace(/[^a-z0-9]/g, '');
        const fileForRegex = file.toLowerCase();
        
        // 1. Dopasowanie Tytułu
        let titleMatch = false;
        if (cleanFile.includes(cleanTargetTitle)) {
            titleMatch = true;
        } else {
            let matchedWords = 0;
            for (const word of titleWords) {
                if (cleanFile.includes(word)) matchedWords++;
            }
            if (titleWords.length > 0 && matchedWords >= Math.ceil(titleWords.length / 2)) {
                titleMatch = true;
            }
        }
        if (!titleMatch) continue;
        
        // 2. Dopasowanie Odcinka i Sezonu
        let episodeMatch = false;
        if (episode !== null && episode !== undefined) {
            const epPad = episode.toString().padStart(2, '0');
            const fileNoRes = fileForRegex.replace(/720p|1080p|480p|2160p/g, '');
            if (season !== null && season > 1) {
                const sPad = season.toString().padStart(2, '0');
                const sRegex = new RegExp(`s${sPad}e${epPad}|season\\s*${season}.*?episode\\s*${episode}`, 'i');
                if (sRegex.test(fileNoRes)) episodeMatch = true;
            }
            if (!episodeMatch) {
                const epRegex = new RegExp(`(?:[^a-z0-9]|^)e?${epPad}(?:[^a-z0-9]|$)|(?:[^a-z0-9]|^)e?${episode}(?:[^a-z0-9]|$)`, 'i');
                if (epRegex.test(fileNoRes)) episodeMatch = true;
            }
        } else {
            episodeMatch = true;
        }
        if (titleMatch && episodeMatch) {
            console.log(`[LOCAL] Znaleziono pasujący plik lokalny: ${file}`);
            const fullPath = path.join(LOCAL_SUBS_DIR, file);
            return { path: fullPath, file: file };
        }
    }
    return null;
}

// ============================================================
// FANSUBY.CC (https://fansuby.cc/api/v1) - główne źródło napisów
// Klucz API ustaw w zmiennej środowiskowej FANSUBY_KEY (Render -> Environment)
// ============================================================
const FANSUBY_API = (process.env.FANSUBY_URL || 'https://fansuby.cc') + '/api/v1';
const FANSUBY_KEY = process.env.FANSUBY_KEY || '';
const fsb = axios.create({
    headers: { Authorization: `Bearer ${FANSUBY_KEY}` },
    timeout: 10000
});
const kitsuMapCache = new Map();
const fansubyCache = new Map();
const FANSUBY_CACHE_TTL = 5 * 60 * 1000;

/** Kitsu ID -> AniList / MAL ID (fansuby szuka po tych identyfikatorach) */
async function kitsuMappings(kitsuId) {
    if (kitsuMapCache.has(kitsuId)) return kitsuMapCache.get(kitsuId);
    const out = {};
    try {
        const r = await axios.get(
            `https://kitsu.io/api/edge/anime/${kitsuId}/mappings`,
            { params: { 'page[limit]': 20 }, headers: { Accept: 'application/vnd.api+json' }, timeout: 5000 }
        );
        for (const m of r.data.data) {
            if (m.attributes.externalSite === 'anilist/anime') out.anilistId = m.attributes.externalId;
            if (m.attributes.externalSite === 'myanimelist/anime') out.malId = m.attributes.externalId;
        }
        kitsuMapCache.set(kitsuId, out);
    } catch (e) {
        console.error('[Kitsu mappings]', e.message);
    }
    return out;
}

/** Szuka napisów w fansuby przez /match i zwraca listę w formacie Stremio */
async function fansubySubtitles(meta, extra) {
    if (!FANSUBY_KEY) return [];

    const params = { format: 'srt', lang: 'pl' };
    const ep = String(meta.episode ?? 1).padStart(2, '0');

    if (extra && extra.filename) {
        params.filename = extra.filename;
    } else if (meta.title) {
        params.filename = (meta.kitsuId || !meta.season)
            ? `${meta.title} - ${ep}.mkv`
            : `${meta.title}.S${String(meta.season).padStart(2, '0')}E${ep}.mkv`;
    } else {
        return [];
    }

    if (meta.kitsuId) {
        const ids = await kitsuMappings(meta.kitsuId);
        if (ids.anilistId) params.anilistId = ids.anilistId;
        else if (ids.malId) params.malId = ids.malId;
        if (meta.episode !== null && meta.episode !== undefined) params.episode = meta.episode;
    }

    const cacheKey = JSON.stringify(params);
    const cached = fansubyCache.get(cacheKey);
    if (cached && Date.now() - cached.time < FANSUBY_CACHE_TTL) return cached.data;

    console.log(`[Fansuby] /match`, params);
    const r = await fsb.get(`${FANSUBY_API}/match`, { params, validateStatus: s => s < 500 });
    if (r.status === 429) {
        console.warn(`[Fansuby] 429 rate limit, Retry-After=${r.headers['retry-after']}`);
        return [];
    }
    if (r.status !== 200) {
        console.log(`[Fansuby] status ${r.status}`);
        return [];
    }

    const preferAss = PREFER_ASS;
    const data = [];
    for (const s of (r.data.data || []).slice(0, 6)) {
        const label = [
            'fansuby',
            s.releaseGroup,
            s.resolution,
            s.credits && s.credits.length ? `by ${s.credits[0].name}` : null
        ].filter(Boolean).join(' | ');
        const entry = (suffix, ext) => ({
            id: `fansuby-${s.id}-${ext}`,
            url: `${BASE_URL_RESOLVED}/subtitles/fansuby/${s.id}.${ext}`,
            lang: 'pol',
            label: `${label} | ${suffix}`,
            SubtitleName: `${label} | ${suffix}`
        });
        const srtEntry = entry('SRT', 'srt');
        if (s.format === 'ass') {
            // oryginalny ASS zachowuje pozycje i style (wymaga "Style ASS subtitles" w ustawieniach Stremio)
            const assEntry = entry('ASS (stylizowane)', 'ass');
            if (preferAss) data.push(assEntry, srtEntry); else data.push(srtEntry, assEntry);
        } else {
            data.push(srtEntry);
        }
    }
    fansubyCache.set(cacheKey, { time: Date.now(), data });
    console.log(`[Fansuby] Znaleziono ${data.length} napisów`);
    return data;
}

/** Dekoduje bufor napisów: UTF-8, a przy błędach Windows-1250 / ISO-8859-2 */
function decodeSubtitleBuffer(buf) {
    const utf8Text = buf.toString('utf-8');
    let text;
    if (!utf8Text.includes('\uFFFD')) {
        text = utf8Text;
    } else {
        const cp1250Text = iconv.decode(buf, 'windows-1250');
        const isoText = iconv.decode(buf, 'ISO-8859-2');
        const plRegex = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g;
        const cp1250Matches = (cp1250Text.match(plRegex) || []).length;
        const isoMatches = (isoText.match(plRegex) || []).length;
        text = isoMatches > cp1250Matches ? isoText : cp1250Text;
    }
    return text.replace(/^\uFEFF/, '');
}

/** Konwertuje WebVTT do SRT */
function convertVttToSrt(vtt) {
    const blocks = vtt.replace(/\r/g, '').split(/\n{2,}/);
    const out = [];
    for (const block of blocks) {
        const lines = block.split('\n');
        const idx = lines.findIndex(l => l.includes('-->'));
        if (idx === -1) continue; // nagłówek WEBVTT, NOTE, STYLE
        let time = lines[idx].replace(/\s+(align|position|line|size):\S+/g, '');
        time = time.replace(/(^|\s)(\d{2}:\d{2})\.(\d{3})/g, '$100:$2.$3')
                   .replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2');
        out.push(`${out.length + 1}\n${time}\n${lines.slice(idx + 1).join('\n')}`);
    }
    return out.join('\n\n');
}

/** Jeśli bufor to ZIP (sygnatura "PK"), zwraca pierwszy plik z napisami; inaczej oddaje bufor bez zmian */
function unwrapZip(buf) {
    if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
        try {
            const zip = new AdmZip(buf);
            const entry = zip.getEntries().find(e => !e.isDirectory && /\.(srt|ass|ssa|vtt|sub|txt)$/i.test(e.entryName));
            if (entry) return entry.getData();
        } catch (e) {
            console.error('[Normalize] Błąd rozpakowywania ZIP:', e.message);
        }
    }
    return buf;
}

/**
 * Przyjmuje dowolny plik napisów (ZIP, ASS/SSA, SRT, VTT, MicroDVD, MPL2, TMPlayer)
 * i zawsze zwraca tekst w formacie SRT. Format wykrywa po zawartości, nie po rozszerzeniu.
 */
function normalizeToSrt(buf) {
    buf = unwrapZip(buf);

    const text = decodeSubtitleBuffer(buf);

    // ASS / SSA
    if (/^\s*\[Script Info\]/im.test(text) || /^\s*\[Events\]/im.test(text) || /^Dialogue:/m.test(text)) {
        try {
            const srt = convertAssToSrt(text);
            if (srt && srt.length > 10) return srt;
        } catch (e) {
            console.error('[Normalize] Błąd ASS->SRT:', e.message);
        }
        return text;
    }
    // WebVTT
    if (/^WEBVTT/i.test(text.trim())) {
        return convertVttToSrt(text);
    }
    // SRT (już gotowy)
    if (text.includes('-->')) {
        return text;
    }
    // MicroDVD / MPL2 / TMPlayer
    try {
        return convertTxtToSrt(text);
    } catch (e) {
        console.error('[Normalize] Błąd TXT->SRT:', e.message);
        return text;
    }
}

const fansubyFileCache = new Map();

/** Pobiera plik z fansuby (z krótkim cache, żeby ASS+SRT nie liczyły się podwójnie do limitu pobrań) */
async function getFansubyFile(id) {
    const cached = fansubyFileCache.get(id);
    if (cached && Date.now() - cached.time < 10 * 60 * 1000) return cached.buf;
    const r = await fsb.get(`${FANSUBY_API}/subtitles/${id}/download`, {
        responseType: 'arraybuffer',
        maxRedirects: 5
    });
    const buf = Buffer.from(r.data);
    fansubyFileCache.set(id, { time: Date.now(), buf });
    if (fansubyFileCache.size > 50) fansubyFileCache.delete(fansubyFileCache.keys().next().value);
    return buf;
}

/** Proxy pobierania - klucz API zostaje po stronie serwera. /subtitles/fansuby/{id}.ass | .srt */
async function serveFansuby(req, res, url) {
    let id = url.searchParams.get('id');
    let mode = url.searchParams.get('as') || 'srt';
    const m = url.pathname.match(/^\/subtitles\/fansuby\/(\d+)\.(ass|srt)$/);
    if (m) { id = m[1]; mode = m[2]; }
    if (!/^\d+$/.test(id || '')) {
        res.writeHead(400);
        res.end('Bad id');
        return;
    }
    try {
        const buf = await getFansubyFile(id);
        let body;
        let contentType = 'text/srt; charset=utf-8';
        if (mode === 'ass') {
            const text = decodeSubtitleBuffer(unwrapZip(buf));
            if (/^\s*\[Script Info\]/im.test(text) || /^\s*\[Events\]/im.test(text)) {
                body = text; // oryginał, bez żadnej konwersji - Stremio sam renderuje style
                contentType = 'text/x-ssa; charset=utf-8';
            } else {
                body = normalizeToSrt(buf);
            }
        } else {
            body = normalizeToSrt(buf);
        }
        res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
        res.end(body);
    } catch (e) {
        const status = (e.response && e.response.status) || 500;
        console.error('[Fansuby Download]', status, e.message);
        const headers = {};
        if (e.response && e.response.headers && e.response.headers['retry-after']) {
            headers['Retry-After'] = e.response.headers['retry-after'];
        }
        res.writeHead(status, headers);
        res.end('Download failed');
    }
}

builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
    console.log(`\n[Request] type=${type}, id=${id}`);
    try {
        const meta = await getMetaInfo(type, id);
        
        const localSub = meta.title ? findLocalSubtitle(meta.title, meta.season, meta.episode) : null;
        if (localSub) {
            console.log('[LOCAL] Using local subtitle file instead of remote search.');
            return {
                subtitles: [{
                    id: `local-${meta.title}-${meta.episode || ''}`,
                    url: `${BASE_URL_RESOLVED}/subtitles/local?file=${encodeURIComponent(path.basename(localSub.path))}`,
                    lang: 'pol',
                    SubtitleName: `Local: ${path.basename(localSub.path)}`
                }]
            };
        }
        
        // Główne źródło: fansuby.cc (animesub.info jako fallback)
        try {
            const fansubySubs = await fansubySubtitles(meta, extra);
            if (fansubySubs.length) {
                return { subtitles: fansubySubs };
            }
        } catch (e) {
            console.error('[Fansuby] Błąd:', e.message);
        }

        console.log(`[Meta] title="${meta.title}", season=${meta.season}, episode=${meta.episode}`);
        if (!meta.title) {
            console.log('[Błąd] Nie udało się pobrać tytułu');
            return { subtitles: [] };
        }
        
        const strategies = generateSearchStrategies(meta.title, meta.season, meta.episode);
        let allSubtitles = [];
        const seenIds = new Set();
        
        for (const strategy of strategies) {
            console.log(`[Strategia] "${strategy.query}" (${strategy.type})`);
            const results = await searchSubtitles(strategy.query, strategy.type);
            const matched = matchSubtitles(results, meta.season, meta.episode, meta.title);
            for (const sub of matched) {
                if (!seenIds.has(sub.id)) {
                    seenIds.add(sub.id);
                    allSubtitles.push({
                        ...sub,
                        searchQuery: strategy.query,
                        searchType: strategy.type
                    });
                }
            }
            const exactMatch = matched.some(s =>
                s.episode === meta.episode &&
                (meta.season === null || meta.season === 1 || s.season === meta.season)
            );
            if (exactMatch && matched.length >= 1) {
                console.log('[Znaleziono] Dokładne dopasowanie, przerywam wyszukiwanie');
                break;
            }
            if (allSubtitles.length >= 5) {
                console.log('[Znaleziono] Wystarczająco wyników, przerywam wyszukiwanie');
                break;
            }
        }
        
        allSubtitles.sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0));
        
        const stremioSubtitles = allSubtitles.slice(0, 10).map(sub => {
            const label = [
                sub.titleEng || sub.titleOrg,
                sub.author ? `by ${sub.author}` : null,
                sub.formatType,
                sub.downloadCount ? `${sub.downloadCount} pobrań` : null
            ].filter(Boolean).join(' | ');
            return {
                id: `animesub-${sub.id}`,
                url: createSubtitleUrl(sub, sub.searchQuery, sub.searchType, meta.episode),
                lang: 'pol',
                label,
                SubtitleName: label
            };
        });
        
        console.log(`[Wynik] Zwracam ${stremioSubtitles.length} napisów`);
        return { subtitles: stremioSubtitles };
    } catch (error) {
        console.error('[Błąd]', error);
        return { subtitles: [] };
    }
});

async function downloadSubtitle(req, res) {
    const { id, hash, query, type } = req.query || req.url.searchParams || {};
    console.log(`[Download] id=${id}, hash=${hash}, query=${query}`);
    if (!id || !hash) {
        res.writeHead(400);
        res.end('Missing parameters');
        return;
    }
    try {
        const downloadSession = axios.create({
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'pl,en;q=0.9',
                'Accept-Charset': 'ISO-8859-2,utf-8;q=0.7,*;q=0.3',
            },
            timeout: 15000,
            responseType: 'arraybuffer',
            withCredentials: true,
        });
        const searchParams = new URLSearchParams({
            szukane: query || 'test',
            pTitle: type || 'org',
            pSortuj: 'pobrn'
        });
        const searchUrl = `${SEARCH_URL}?${searchParams.toString()}`;
        console.log(`[Download] Krok 1: Pobieram stronę wyszukiwania`);
        
        const searchResponse = await downloadSession.get(searchUrl);
        const cookies = searchResponse.headers['set-cookie'] || [];
        const cookieString = cookies.map(c => c.split(';')[0]).join('; ');
        const searchHtml = iconv.decode(Buffer.from(searchResponse.data), 'ISO-8859-2');
        const $ = cheerio.load(searchHtml);
        let freshHash = null;
        
        $('form[method="POST"][action="sciagnij.php"]').each((i, form) => {
            const formId = $(form).find('input[name="id"]').val();
            if (formId === id || formId === String(id)) {
                freshHash = $(form).find('input[name="sh"]').val();
                console.log(`[Download] ✓ Znaleziono świeży hash dla id=${id}`);
            }
        });
        
        if (!freshHash) {
            console.log(`[Download] ✗ Nie znaleziono formularza dla id=${id}, używam oryginalnego hasha`);
            freshHash = hash;
        }
        
        console.log(`[Download] Krok 2: Pobieram napisy`);
        const downloadResponse = await downloadSession.post(DOWNLOAD_URL,
            new URLSearchParams({
                id: id,
                sh: freshHash,
                single_file: 'Pobierz napisy'
            }).toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': searchUrl,
                    'Origin': BASE_URL,
                    'Cookie': cookieString,
                },
                responseType: 'arraybuffer'
            }
        );
        
        let subtitleContent = Buffer.from(downloadResponse.data);
        console.log(`[Download] Pobrano ${subtitleContent.length} bajtów`);
        
        const rawText = subtitleContent.toString('latin1');
        if (rawText.includes('zabezpiecze') || rawText.includes('Błąd') || rawText.includes('B³±d')) {
            console.log(`[Download] ✗ BŁĄD ZABEZPIECZEŃ!`);
            throw new Error('Błąd zabezpieczeń animesub.info - hash nieważny');
        }
        
        let subtitleExtension = '.srt';
        if (subtitleContent[0] === 0x50 && subtitleContent[1] === 0x4B) {
            console.log('[Download] Rozpakowywanie ZIP...');
            const zip = new AdmZip(subtitleContent);
            const entries = zip.getEntries();
            let subtitleEntry = null;
            const targetEp = req.query.episode;
            
            if (targetEp && targetEp !== 'undefined' && targetEp !== 'null') {
                const epRegex = new RegExp(`(?:[^a-zA-Z0-9]|^)0*${targetEp}(?:[^a-zA-Z0-9]|$)`, 'i');
                subtitleEntry = entries.find(e => {
                    const isSub = /\.(srt|ass|ssa|sub|txt)$/i.test(e.entryName);
                    const isCorrectEp = epRegex.test(e.entryName);
                    return isSub && isCorrectEp;
                });
                if (subtitleEntry) {
                    console.log(`[Download] ✓ Znaleziono w paczce odpowiedni odcinek: ${subtitleEntry.entryName}`);
                }
            }
            if (!subtitleEntry) {
                subtitleEntry = entries.find(e => /\.(srt|ass|ssa|sub|txt)$/i.test(e.entryName));
                console.log(`[Download] ! Wzięto domyślny plik z paczki: ${subtitleEntry ? subtitleEntry.entryName : 'Brak'}`);
            }
            if (subtitleEntry) {
                subtitleContent = subtitleEntry.getData();
                subtitleExtension = require('path').extname(subtitleEntry.entryName).toLowerCase() || '.srt';
                console.log(`[Download] Rozpakowano: ${subtitleEntry.entryName}`);
            }
        }
        
        let textContent;
        const utf8Text = subtitleContent.toString('utf-8');
        
        if (!utf8Text.includes('\uFFFD')) {
            textContent = utf8Text;
            console.log('[Download] ✓ Zdekodowano jako UTF-8');
        } else {
            const cp1250Text = iconv.decode(subtitleContent, 'windows-1250');
            const isoText = iconv.decode(subtitleContent, 'ISO-8859-2');
            const plRegex = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g;
            const cp1250Matches = (cp1250Text.match(plRegex) || []).length;
            const isoMatches = (isoText.match(plRegex) || []).length;
            if (isoMatches > cp1250Matches) {
                textContent = isoText;
                console.log(`[Download] ✓ Zdekodowano jako ISO-8859-2 (Trafienia: ${isoMatches})`);
            } else {
                textContent = cp1250Text;
                console.log(`[Download] ✓ Zdekodowano jako Windows-1250 (Trafienia: ${cp1250Matches})`);
            }
        }
        
        textContent = textContent.replace(/^\uFEFF/, '');
        
        const looksLikeAss = /^\s*\[Script Info\]/im.test(textContent) || /^\s*\[Events\]/im.test(textContent);
        if (PREFER_ASS && (subtitleExtension === '.ass' || subtitleExtension === '.ssa' || looksLikeAss)) {
            console.log('[Download] PREFER_ASS=1 - wysyłam oryginalny ASS/SSA bez konwersji');
            res.writeHead(200, {
                'Content-Type': 'text/x-ssa; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            });
            res.end(textContent);
            return;
        }

        if (subtitleExtension === '.ass' || subtitleExtension === '.ssa') {
            console.log('[Download] Konwertuję ASS/SSA do SRT...');
            try {
                const srtContent = convertAssToSrt(textContent);
                if (srtContent && srtContent.length > 10) {
                    textContent = srtContent;
                    subtitleExtension = '.srt';
                    console.log(`[Download] ✓ Skonwertowano do SRT`);
                }
            } catch (convError) {
                console.error('[Download] Błąd konwersji ASS->SRT:', convError.message);
            }
        } else if (subtitleExtension === '.txt' || subtitleExtension === '.sub') {
            console.log('[Download] Konwertuję TXT/SUB do SRT...');
            try {
                const srtContent = convertTxtToSrt(textContent);
                if (srtContent !== textContent) {
                    textContent = srtContent;
                    subtitleExtension = '.srt';
                    console.log(`[Download] ✓ Skonwertowano TXT do SRT`);
                }
            } catch (convError) {
                console.error('[Download] Błąd konwersji TXT->SRT:', convError.message);
            }
        }
        
        console.log(`[Download] ✓ Wysyłam napisy (${textContent.length} znaków)`);
        res.writeHead(200, {
            'Content-Type': 'text/srt; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end(textContent);
    } catch (error) {
        console.error('[Download Error]', error.message);
        res.writeHead(500);
        res.end('Download failed: ' + error.message);
    }
}

function serveLocalSubtitle(req, res) {
    const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const fileParam = urlParams.get('file');
    if (!fileParam) {
        res.writeHead(400);
        res.end('Missing file param');
        return;
    }
    const file = path.basename(fileParam);
    const fullPath = path.join(LOCAL_SUBS_DIR, file);
    if (!fs.existsSync(fullPath)) {
        res.writeHead(404);
        res.end('Subtitle not found');
        return;
    }
    let textContent = fs.readFileSync(fullPath, 'utf-8');
    const ext = path.extname(file).toLowerCase();
    
    if (ext === '.ass' || ext === '.ssa') {
        try {
            console.log(`[LOCAL] Konwertuję lokalny plik ASS do SRT: ${file}`);
            textContent = convertAssToSrt(textContent);
        } catch (e) {
            console.error('[LOCAL] Błąd konwersji ASS:', e.message);
        }
    } else if (ext === '.txt' || ext === '.sub') {
        try {
            console.log(`[LOCAL] Konwertuję lokalny plik TXT do SRT: ${file}`);
            textContent = convertTxtToSrt(textContent);
        } catch (e) {
            console.error('[LOCAL] Błąd konwersji TXT:', e.message);
        }
    }
    
    res.writeHead(200, {
        'Content-Type': 'text/srt; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(textContent);
}

const PORT = process.env.PORT || 7000;
const http = require('http');

if (process.env.BASE_URL) {
    BASE_URL_RESOLVED = process.env.BASE_URL.replace(/\/$/, '');
} else if (process.env.RENDER_EXTERNAL_URL) {
    BASE_URL_RESOLVED = process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
} else if (process.env.SPACE_HOST) {
    BASE_URL_RESOLVED = `https://${process.env.SPACE_HOST}`;
} else if (process.env.SPACE_ID) {
    const spaceId = process.env.SPACE_ID.replace('/', '-').toLowerCase();
    BASE_URL_RESOLVED = `https://${spaceId}.hf.space`;
} else {
    BASE_URL_RESOLVED = `http://localhost:${PORT}`;
}

console.log(`[Config] BASE_URL: ${BASE_URL_RESOLVED}`);

const addonInterface = builder.getInterface();
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400'
        });
        res.end();
        return;
    }
    
    if (url.pathname === '/subtitles/fansuby' || url.pathname.startsWith('/subtitles/fansuby/')) {
        serveFansuby(req, res, url);
        return;
    }

    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }

    if (url.pathname === '/subtitles/download' || /^\/subtitles\/download\/[^/]+\.(ass|ssa)$/i.test(url.pathname)) {
        req.query = Object.fromEntries(url.searchParams);
        downloadSubtitle(req, res);
        return;
    }
    
    const addonRouter = getRouter(addonInterface);
    if (url.pathname === '/subtitles/local') {
        serveLocalSubtitle(req, res);
        return;
    }
    
    addonRouter(req, res, () => {
        res.writeHead(404);
        res.end('Not found');
    });
});

server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║         AnimeSub.info Stremio Addon                        ║
╠════════════════════════════════════════════════════════════╣
║  Serwer uruchomiony na: http://localhost:${PORT}              ║
║                                                            ║
║  Link do instalacji w Stremio:                             ║
║  http://localhost:${PORT}/manifest.json                       ║
║                                                            ║
║  Aby zainstalować:                                         ║
║  1. Otwórz Stremio                                         ║
║  2. Idź do Addons -> Community Addons                      ║
║  3. Wklej powyższy link w pole "Addon Repository URL"      ║
╚════════════════════════════════════════════════════════════╝
`);
});