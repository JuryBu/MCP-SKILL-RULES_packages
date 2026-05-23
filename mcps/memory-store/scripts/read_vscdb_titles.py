"""从 state.vscdb 读取 trajectorySummaries 的对话标题，输出 JSON"""
import sqlite3, base64, json, sys, os

def main():
    db_path = os.path.join(
        os.environ.get('APPDATA', os.path.join(os.path.expanduser('~'), 'AppData', 'Roaming')),
        'Antigravity', 'User', 'globalStorage', 'state.vscdb'
    )
    if not os.path.exists(db_path):
        print('{}')
        return

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("SELECT value FROM ItemTable WHERE key='antigravityUnifiedStateSync.trajectorySummaries'")
    row = cur.fetchone()
    conn.close()
    if not row:
        print('{}')
        return

    def dv(d, o):
        r = 0; s = 0
        while o < len(d):
            b = d[o]; r |= (b & 0x7F) << s; o += 1
            if not (b & 0x80): break
            s += 7
        return r, o

    def df(d):
        res = []; o = 0
        while o < len(d):
            try:
                t, o2 = dv(d, o)
                if o2 == o: break
                o = o2; fn = t >> 3; wt = t & 7
                if wt == 0: v, o = dv(d, o); res.append((fn, 0, v))
                elif wt == 2:
                    l, o = dv(d, o)
                    if l < 0 or l > len(d) - o: break
                    res.append((fn, 2, d[o:o+l])); o += l
                elif wt == 1: o += 8; res.append((fn, 1, 0))
                elif wt == 5: o += 4; res.append((fn, 5, 0))
                else: break
            except: break
        return res

    def ts(d):
        try:
            s = d.decode('utf-8')
            if all(c.isprintable() or c in '\n\r\t' for c in s): return s
        except: pass
        return None

    decoded = base64.b64decode(row[0])
    entries = df(decoded)
    out = {}
    for fn, wt, fv in entries:
        if fn == 1 and wt == 2:
            sub = df(fv); uuid = None; vr = None
            for sfn, swt, sfv in sub:
                if sfn == 1 and swt == 2:
                    s = ts(sfv)
                    if s and len(s) == 36: uuid = s
                elif sfn == 2 and swt == 2: vr = sfv
            if uuid and vr:
                for rfn, rwt, rfv in df(vr):
                    if rfn == 1 and rwt == 2:
                        s = ts(rfv)
                        if s and len(s) > 10:
                            try:
                                inner = base64.b64decode(s)
                                sm = None; sc = None
                                for ifn, iwt, ifv in df(inner):
                                    if ifn == 1 and iwt == 2: sm = ts(ifv)
                                    elif ifn == 2 and iwt == 0: sc = ifv
                                if sm: out[uuid] = {'s': sm, 'c': sc}
                            except: pass
    print(json.dumps(out, ensure_ascii=False))

if __name__ == '__main__':
    main()
