export type AmbiguousWidth = 'narrow' | 'wide';

export const UNICODE_WIDTH_SOURCE = Object.freeze({
    version: '18.0.0',
    url: 'https://www.unicode.org/Public/18.0.0/ucd/EastAsianWidth.txt',
    sha256: 'a0cf29eacd00cfcaec4381c6b7c281685f18dbb4e7ff82b4076ccb342ca839aa',
    licenseUrl: 'https://www.unicode.org/license.txt',
    licenseNotice: [
        "UNICODE LICENSE V3",
        "",
        "COPYRIGHT AND PERMISSION NOTICE",
        "",
        "Copyright © 1991-2026 Unicode, Inc.",
        "",
        "NOTICE TO USER: Carefully read the following legal agreement. BY",
        "DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR",
        "SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE",
        "TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT",
        "DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.",
        "",
        "Permission is hereby granted, free of charge, to any person obtaining a",
        "copy of data files and any associated documentation (the \"Data Files\") or",
        "software and any associated documentation (the \"Software\") to deal in the",
        "Data Files or Software without restriction, including without limitation",
        "the rights to use, copy, modify, merge, publish, distribute, and/or sell",
        "copies of the Data Files or Software, and to permit persons to whom the",
        "Data Files or Software are furnished to do so, provided that either (a)",
        "this copyright and permission notice appear with all copies of the Data",
        "Files or Software, or (b) this copyright and permission notice appear in",
        "associated Documentation.",
        "",
        "THE DATA FILES AND SOFTWARE ARE PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY",
        "KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF",
        "MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF",
        "THIRD PARTY RIGHTS.",
        "",
        "IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE",
        "BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,",
        "OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,",
        "WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,",
        "ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA",
        "FILES OR SOFTWARE.",
        "",
        "Except as contained in this notice, the name of a copyright holder shall",
        "not be used in advertising or otherwise to promote the sale, use or other",
        "dealings in these Data Files or Software without prior written",
        "authorization of the copyright holder.",
    ].join('\n'),
});

function ranges(source: string): readonly (readonly [number, number])[] {
    return Object.freeze(source.split(',').map(entry => {
        const [start, end] = entry.split('-');
        return Object.freeze([Number.parseInt(start, 16), Number.parseInt(end, 16)] as const);
    }));
}

const ambiguous = ranges([
    "a1-a1,a4-a4,a7-a8,aa-aa,ad-ae,b0-b4,b6-ba,bc-bf,c6-c6,d0-d0,d7-d8,de-e1",
    "e6-e6,e8-ea,ec-ed,f0-f0,f2-f3,f7-fa,fc-fc,fe-fe,101-101,111-111,113-113,11b-11b",
    "126-127,12b-12b,131-133,138-138,13f-142,144-144,148-14b,14d-14d,152-153,166-167,16b-16b,1ce-1ce",
    "1d0-1d0,1d2-1d2,1d4-1d4,1d6-1d6,1d8-1d8,1da-1da,1dc-1dc,251-251,261-261,2c4-2c4,2c7-2c7,2c9-2cb",
    "2cd-2cd,2d0-2d0,2d8-2db,2dd-2dd,2df-2df,300-36f,391-3a1,3a3-3a9,3b1-3c1,3c3-3c9,401-401,410-44f",
    "451-451,2010-2010,2013-2016,2018-2019,201c-201d,2020-2022,2024-2027,2030-2030,2032-2033,2035-2035,203b-203b,203e-203e",
    "2074-2074,207f-207f,2081-2084,20ac-20ac,2103-2103,2105-2105,2109-2109,2113-2113,2116-2116,2121-2122,2126-2126,212b-212b",
    "2153-2154,215b-215e,2160-216b,2170-2179,2189-2189,2190-2199,21b8-21b9,21d2-21d2,21d4-21d4,21e7-21e7,2200-2200,2202-2203",
    "2207-2208,220b-220b,220f-220f,2211-2211,2215-2215,221a-221a,221d-2220,2223-2223,2225-2225,2227-222c,222e-222e,2234-2237",
    "223c-223d,2248-2248,224c-224c,2252-2252,2260-2261,2264-2267,226a-226b,226e-226f,2282-2283,2286-2287,2295-2295,2299-2299",
    "22a5-22a5,22bf-22bf,2312-2312,2460-24e9,24eb-254b,2550-2573,2580-258f,2592-2595,25a0-25a1,25a3-25a9,25b2-25b3,25b6-25b7",
    "25bc-25bd,25c0-25c1,25c6-25c8,25cb-25cb,25ce-25d1,25e2-25e5,25ef-25ef,2605-2606,2609-2609,260e-260f,261c-261c,261e-261e",
    "2640-2640,2642-2642,2660-2661,2663-2665,2667-266a,266c-266d,266f-266f,269e-269f,26bf-26bf,26c6-26cd,26cf-26d3,26d5-26e1",
    "26e3-26e3,26e8-26e9,26eb-26f1,26f4-26f4,26f6-26f9,26fb-26fc,26fe-26ff,273d-273d,2776-277f,2b56-2b59,3248-324f,e000-f8ff",
    "fe00-fe0f,fffd-fffd,1f100-1f10a,1f110-1f12d,1f130-1f169,1f170-1f18d,1f18f-1f190,1f19b-1f1ac,e0100-e01ef,f0000-ffffd,100000-10fffd",
].join(','));

const wide = ranges([
    "1100-115f,231a-231b,2329-232a,23e9-23ec,23f0-23f0,23f3-23f3,25fd-25fe,2614-2615,2630-2637,2648-2653,267f-267f,268a-268f",
    "2693-2693,26a1-26a1,26aa-26ab,26bd-26be,26c4-26c5,26ce-26ce,26d4-26d4,26ea-26ea,26f2-26f3,26f5-26f5,26fa-26fa,26fd-26fd",
    "2705-2705,270a-270b,2728-2728,274c-274c,274e-274e,2753-2755,2757-2757,2795-2797,27b0-27b0,27bf-27bf,2b1b-2b1c,2b50-2b50",
    "2b55-2b55,2e80-2e99,2e9b-2ef3,2f00-2fd5,2ff0-303e,3041-3096,3099-30ff,3105-312f,3131-318e,3190-31e5,31ef-321e,3220-3247",
    "3250-a48c,a490-a4c6,a960-a97c,ac00-d7a3,f900-faff,fe10-fe19,fe30-fe52,fe54-fe66,fe68-fe6b,ff01-ff60,ffe0-ffe6,16fe0-16fe4",
    "16ff0-16ff6,17000-18cda,18cff-18d20,18d80-18df2,18e00-19191,191a0-191d2,1aff0-1aff3,1aff5-1affb,1affd-1affe,1b000-1b128,1b132-1b132,1b150-1b152",
    "1b155-1b155,1b164-1b168,1b170-1b2fb,1d300-1d356,1d360-1d376,1f004-1f004,1f0cf-1f0cf,1f18e-1f18e,1f191-1f19a,1f1ae-1f1ae,1f200-1f202,1f210-1f23b",
    "1f240-1f248,1f250-1f251,1f260-1f265,1f300-1f320,1f32d-1f335,1f337-1f37c,1f37e-1f393,1f3a0-1f3ca,1f3cf-1f3d3,1f3e0-1f3f0,1f3f4-1f3f4,1f3f8-1f43e",
    "1f440-1f440,1f442-1f4fc,1f4ff-1f53d,1f54b-1f54e,1f550-1f567,1f57a-1f57a,1f595-1f596,1f5a4-1f5a4,1f5fb-1f64f,1f680-1f6c5,1f6cc-1f6cc,1f6d0-1f6d2",
    "1f6d5-1f6d9,1f6dc-1f6df,1f6eb-1f6ec,1f6f4-1f6fc,1f7da-1f7da,1f7e0-1f7eb,1f7f0-1f7f0,1f90c-1f93a,1f93c-1f945,1f947-1f9ff,1fa70-1fa7c,1fa80-1fac6",
    "1fac8-1fac8,1facc-1fadd,1fadf-1faeb,1faef-1fafa,20000-2fffd,30000-3fffd",
].join(','));

function contains(entries: readonly (readonly [number, number])[], code: number): boolean {
    let first = 0;
    let last = entries.length - 1;
    while (first <= last) {
        const middle = (first + last) >>> 1;
        const [start, end] = entries[middle];
        if (code < start) last = middle - 1;
        else if (code > end) first = middle + 1;
        else return true;
    }
    return false;
}

export function eastAsianCharacterWidth(code: number, ambiguousWidth: AmbiguousWidth = 'narrow'): number {
    return contains(wide, code) || ambiguousWidth === 'wide' && contains(ambiguous, code) ? 2 : 1;
}

