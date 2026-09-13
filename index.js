const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

// Zmienna globalna dla BASE_URL - ustawiana przy starcie serwera
let BASE_URL_RESOLVED = '';

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
    if (lines.some(l => l.includes('-->'))) {
        return textContent;
    }
    let srt = '';
    let counter = 1;
    const fps = 23.976;

    const isTMPlayer = lines.some(l => l.match(/^\d{2}:\d{2}:\d{2}:/));
    if (isTMPlayer) {
        const parsedLines = [];
        for (let line of lines) {
            line = line.trim();
            if (!line) continue;
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
                parsedLines[parsedLines.length - 1].text += '\n' + line.replace(/^\|/, '');
            }
        }
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

    const parsedOther = [];
    for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        const mplMatch = line.match(/^\[(\d+)\]\[(\d+)\](.*)/);
        if (mplMatch) {
            const startMs = parseInt(mplMatch[1], 10) * 100;
            const endMs = parseInt(mplMatch[2], 10) * 100;
            let text = mplMatch[3].replace(/\|/g, '\n');
            parsedOther.push({ startMs, endMs, text });
            continue;
        }
        const mdvdMatch = line.match(/^\{(\d+)\}\{(\d+)\}(.*)/);
        if (mdvdMatch) {
            const startMs = Math.round((parseInt(mdvdMatch[1], 10) / fps) * 1000);
            const endMs = Math.round((parseInt(mdvdMatch[2], 10) / fps) * 1000);
            let text = mdvdMatch[3].replace(/\|/g, '\n');
            parsedOther.push({ startMs, endMs, text });
            continue;
        }
        if (parsedOther.length > 0) {
            parsedOther[parsedOther.length - 1].text += '\n' + line.replace(/^\|/, '');
        }
    }
    for (let sub of parsedOther) {
        srt += `${counter++}\n${formatSrtTime(sub.startMs)} --> ${formatSrtTime(sub.endMs)}\n${sub.text}\n\n`;
    }
    return srt.length > 0 ? srt.trim() : textContent;
}

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

function stripAssTags(text) {
    let result = text.replace(/\{[^}]*\}/g, '');
    result = result.replace(/\\N/g, '\n');
    result = result.replace(/\\n/g, '\n');
    result = result.replace(/\\h/g, ' ');
    return result.trim();
}

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

function convertAssToSrt(assContent) {
    const lines = assContent.split('\n');
    let inEvents = false;
    let formatFields = [];
    const rawDialogues = [];

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.toLowerCase() === '[events]') {
            inEvents = true;
            continue;
        }
        if (trimmedLine.startsWith('[') && trimmedLine.toLowerCase() !== '[events]') {
            inEvents = false;
            continue;
        }
        if (!inEvents) continue;
        if (trimmedLine.toLowerCase().startsWith('format:')) {
            formatFields = trimmedLine.substring(7).trim().split(',').map(f => f.trim().toLowerCase());
            continue;
        }
        if (trimmedLine.toLowerCase().startsWith('dialogue:')) {
            const dialogueStr = trimmedLine.substring(9).trim();
            const parts = [];
            let current = '';
            let fieldCount = 0;
            for (let i = 0; i < dialogueStr.length; i++) {
                const char = dialogueStr[i];
                if (char === ',' && fieldCount < formatFields.length - 1) {
                    parts.push(current.trim());
                    current = '';
                    fieldCount++;
                } else {
                    current += char;
                }
            }
            parts.push(current.trim());

            const startIdx = formatFields.indexOf('start');
            const endIdx = formatFields.indexOf('end');
            const textIdx = formatFields.indexOf('text');

            if (startIdx === -1 || endIdx === -1 || textIdx === -1) continue;
            if (parts.length <= Math.max(startIdx, endIdx, textIdx)) continue;

            const rawText = parts[textIdx];
            if (/\{\\p[1-9]\}/i.test(rawText)) continue;
            const text = stripAssTags(rawText);
            if (!text) continue;
            if (/^[ml]\s+\-?[\d.]+\s+\-?[\d.]+/i.test(text)) continue;

            const startMs = srtTimeToMs(assTimeToSrt(parts[startIdx]));
            const endMs = srtTimeToMs(assTimeToSrt(parts[endIdx]));

            if (endMs <= startMs) continue;
            if (endMs - startMs > 60000) continue;

            rawDialogues.push({ startMs, endMs, text });
        }
    }

    const timePoints = new Set();
    rawDialogues.forEach(d => {
        timePoints.add(d.startMs);
        timePoints.add(d.endMs);
    });

    const sortedTimes = Array.from(timePoints).sort((a, b) => a - b);
    const slicedBlocks = [];

    for (let i = 0; i < sortedTimes.length - 1; i++) {
        const start = sortedTimes[i];
        const end = sortedTimes[i + 1];
        if (start === end) continue;

        const activeTexts = rawDialogues
            .filter(d => d.startMs <= start && d.endMs >= end)
            .map(d => d.text);

        if (activeTexts.length > 0) {
            slicedBlocks.push({ startMs: start, endMs: end, text: [...new Set(activeTexts)].join('\n') });
        }
    }

    const optimizedBlocks = [];
    for (const block of slicedBlocks) {
        if (optimizedBlocks.length > 0) {
            const lastBlock = optimizedBlocks[optimizedBlocks.length - 1];
            if (lastBlock.text === block.text && lastBlock.endMs === block.startMs) {
                lastBlock.endMs = block.endMs;
                continue;
            }
        }
        optimizedBlocks.push(block);
    }

    let srt = '';
    for (let i = 0; i < optimizedBlocks.length; i++) {
        const d = optimizedBlocks[i];
        srt += `${i + 1}\n${formatSrtTime(d.startMs)} --> ${formatSrtTime(d.endMs)}\n${d.text}\n\n`;
    }
    return srt.trim();
}

const BASE_URL = 'http://animesub.info';
const SEARCH_URL = `${BASE_URL}/szukaj.php`;
const DOWNLOAD_URL = `${BASE_URL}/sciagnij.php`;

const manifest = {
    id: 'community.animesub.info',
    version: '1.0.0',
    name: 'AnimeSub.info Subtitles',
    description: 'Polskie napisy do anime z animesub.info',
    logo: 'https://i.imgur.com/qKLYVZx.png',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'kitsu'],
    catalogs: [],
    behaviorHints: { configurable: false, configurationRequired: false }
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
                headers: { 'Accept': 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json' },
                timeout: 5000
            });
            const anime = response.data.data.attributes;
            title = anime.titles?.en_jp || anime.canonicalTitle || anime.titles?.ja_jp || anime.titles?.en;
            year = anime.startDate ? parseInt(anime.startDate.substring(0, 4), 10) : null;
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
            return { title: meta.name, year: meta.year, season, episode, imdbId };
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
        return cached.results;
    }
    try {
        const response = await session.get(SEARCH_URL, { params: { szukane: title, pTitle: titleType } });
        const html = iconv.decode(Buffer.from(response.data), 'ISO-8859-2');
        const results = parseSearchResults(html);
        searchCache.set(cacheKey, { results, timestamp: Date.now() });
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
                downloadCount = parseInt($(row3Cells[3]).text().trim().split(' ')[0], 10) || 0;
            }
            const downloadRow = $(table).find('tr.KKom');
            const form = downloadRow.find('form[method="POST"]');
            const subtitleId = form.find('input[name="id"]').val();
            const downloadHash = form.find('input[name="sh"]').val();
            const description = downloadRow.find('td.KNap[align="left"]').text().trim();
            if (!subtitleId || !downloadHash) return;
            const episodeInfo = parseEpisodeInfo(titleOrg, titleEng, titleAlt, description);
            subtitles.push({ id: subtitleId, hash: downloadHash, titleOrg, titleEng, titleAlt, author, formatType, downloadCount, description, ...episodeInfo });
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
    
    for (const text of texts) {
        if (season === null) {
            const seasonMatch = text.match(/(?:Season|Sezon|S|Part)\s*\.?\s*(\d+)|(\d+)(?:nd|rd|th)\s+(?:Season|Sezon)/i);
            if (seasonMatch) season = parseInt(seasonMatch[1] || seasonMatch[2], 10);
        }
    }
    if (season === null) {
        for (const title of [titleOrg, titleEng, titleAlt].filter(Boolean)) {
            const romanMatch = title.match(/\b(II|III|IV|V|VI)\b/i);
            if (romanMatch) {
                const romanToNum = { 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5, 'vi': 6 };
                season = romanToNum[romanMatch[1].toLowerCase()];
                break;
            }
        }
    }
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
    if (epStart === null) {
        for (const text of texts) {
            if (episode === null) {
                const epMatch = text.match(/(?:ep|episode|odc|odcinek)\s*\.?\s*(\d+)/i);
                if (epMatch) episode = parseInt(epMatch[1], 10);
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
    let rightSide = title.includes(':') ? title.split(':').slice(1).join(' ').replace(/[^a-zA-Z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim() : "";
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
            if (season && season > 1) strategies.push({ type: 'org', query: `${name} ${season} ep${epPad}` });
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
        
        if (targetSeason !== null) {
            if (sub.season !== null && sub.season !== targetSeason) return false;
            if (targetSeason > 1 && sub.season === null) return false;
        }
        
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
    const params = new URLSearchParams({ id: subtitle.id, hash: subtitle.hash, query: searchQuery, type: searchType });
    if (episode !== null && episode !== undefined) params.append('episode', episode);
    return `${BASE_URL_RESOLVED}/subtitles/download?${params.toString()}`;
}

builder.defineSubtitlesHandler(async ({ type, id }) => {
    try {
        const meta = await getMetaInfo(type, id);
        if (!meta.title) return { subtitles: [] };
        
        const strategies = generateSearchStrategies(meta.title, meta.season, meta.episode);
        let allSubtitles = [];
        const seenIds = new Set();
        
        for (const strategy of strategies) {
            const results = await searchSubtitles(strategy.query, strategy.type);
            const matched = matchSubtitles(results, meta.season, meta.episode, meta.title);
            for (const sub of matched) {
                if (!seenIds.has(sub.id)) {
                    seenIds.add(sub.id);
                    allSubtitles.push({ ...sub, searchQuery: strategy.query, searchType: strategy.type });
                }
            }
            const exactMatch = matched.some(s => s.episode === meta.episode && (meta.season === null || meta.season === 1 || s.season === meta.season));
            if (exactMatch && matched.length >= 1) break;
            if (allSubtitles.length >= 5) break;
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
                SubtitleName: label
            };
        });
        
        return { subtitles: stremioSubtitles };
    } catch (error) {
        console.error('[Błąd]', error);
        return { subtitles: [] };
    }
});

async function downloadSubtitle(req, res) {
    const { id, hash, query, type } = req.query || req.url.searchParams || {};
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
        const searchParams = new URLSearchParams({ szukane: query || 'test', pTitle: type || 'org', pSortuj: 'pobrn' });
        const searchUrl = `${SEARCH_URL}?${searchParams.toString()}`;
        
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
            }
        });
        
        if (!freshHash) freshHash = hash;
        
        const downloadResponse = await downloadSession.post(DOWNLOAD_URL,
            new URLSearchParams({ id: id, sh: freshHash, single_file: 'Pobierz napisy' }).toString(),
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': searchUrl, 'Origin': BASE_URL, 'Cookie': cookieString },
                responseType: 'arraybuffer'
            }
        );
        
        let subtitleContent = Buffer.from(downloadResponse.data);
        const rawText = subtitleContent.toString('latin1');
        if (rawText.includes('zabezpiecze') || rawText.includes('Błąd') || rawText.includes('B³±d')) {
            throw new Error('Błąd zabezpieczeń animesub.info - hash nieważny');
        }
        
        let subtitleExtension = '.srt';
        if (subtitleContent[0] === 0x50 && subtitleContent[1] === 0x4B) {
            const zip = new AdmZip(subtitleContent);
            const entries = zip.getEntries();
            let subtitleEntry = null;
            const targetEp = req.query.episode;
            
            if (targetEp && targetEp !== 'undefined' && targetEp !== 'null') {
                const epRegex = new RegExp(`(?:[^a-zA-Z0-9]|^)0*${targetEp}(?:[^a-zA-Z0-9]|$)`, 'i');
                subtitleEntry = entries.find(e => /\.(srt|ass|ssa|sub|txt)$/i.test(e.entryName) && epRegex.test(e.entryName));
            }
            if (!subtitleEntry) {
                subtitleEntry = entries.find(e => /\.(srt|ass|ssa|sub|txt)$/i.test(e.entryName));
            }
            if (subtitleEntry) {
                subtitleContent = subtitleEntry.getData();
                subtitleExtension = path.extname(subtitleEntry.entryName).toLowerCase() || '.srt';
            }
        }
        
        let textContent;
        const utf8Text = subtitleContent.toString('utf-8');
        
        if (!utf8Text.includes('\uFFFD')) {
            textContent = utf8Text;
        } else {
            const cp1250Text = iconv.decode(subtitleContent, 'windows-1250');
            const isoText = iconv.decode(subtitleContent, 'ISO-8859-2');
            const plRegex = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g;
            if ((isoText.match(plRegex) || []).length > (cp1250Text.match(plRegex) || []).length) {
                textContent = isoText;
            } else {
                textContent = cp1250Text;
            }
        }
        
        textContent = textContent.replace(/^\uFEFF/, '');
        
        if (subtitleExtension === '.ass' || subtitleExtension === '.ssa') {
            try {
                const srtContent = convertAssToSrt(textContent);
                if (srtContent && srtContent.length > 10) {
                    textContent = srtContent;
                    subtitleExtension = '.srt';
                }
            } catch (convError) {
                console.error('Błąd konwersji ASS->SRT:', convError.message);
            }
        } else if (subtitleExtension === '.txt' || subtitleExtension === '.sub') {
            try {
                const srtContent = convertTxtToSrt(textContent);
                if (srtContent !== textContent) {
                    textContent = srtContent;
                    subtitleExtension = '.srt';
                }
            } catch (convError) {
                console.error('Błąd konwersji TXT->SRT:', convError.message);
            }
        }
        
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

const PORT = process.env.PORT || 7000;
const http = require('http');

if (process.env.BASE_URL) {
    BASE_URL_RESOLVED = process.env.BASE_URL;
} else if (process.env.SPACE_HOST) {
    BASE_URL_RESOLVED = `https://${process.env.SPACE_HOST}`;
} else if (process.env.SPACE_ID) {
    const spaceId = process.env.SPACE_ID.replace('/', '-').toLowerCase();
    BASE_URL_RESOLVED = `https://${spaceId}.hf.space`;
} else {
    BASE_URL_RESOLVED = `http://localhost:${PORT}`;
}

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
    
    if (url.pathname === '/subtitles/download') {
        req.query = Object.fromEntries(url.searchParams);
        downloadSubtitle(req, res);
        return;
    }
    
    const addonRouter = getRouter(addonInterface);
    addonRouter(req, res, () => {
        res.writeHead(404);
        res.end('Not found');
    });
});

server.listen(PORT, () => {
    console.log(`Serwer uruchomiony na porcie ${PORT}`);
});
