"""Drive gluon in a pty and print the screen at checkpoints.

usage: drive.py <cols> <rows> <cwd> -- <argv...>  with steps on stdin, one per line:
  wait <seconds> | keys <python-escaped string> | shot <label> | exited
Needs pyte (pip install pyte).
"""
import os, pty, select, sys, time, codecs
import pyte

cols, rows, cwd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
argv = sys.argv[sys.argv.index("--") + 1:]
steps = [l.rstrip("\n") for l in sys.stdin if l.strip()]

screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.environ.update(COLUMNS=str(cols), LINES=str(rows), TERM="xterm-256color", COLORTERM="truecolor")
    import fcntl, termios, struct
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.execvp(argv[0], argv)

def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            # Answer the background-colour query (OSC 11) like a real dark terminal does.
            if b"\x1b]11;?" in data and os.environ.get("DRIVE_NO_OSC11") is None:
                os.write(fd, b"\x1b]11;rgb:0c0c/0c0c/0c0c\x07")
            stream.feed(data)
    return True

def shot(label):
    print(f"===== {label} " + "=" * max(0, cols - len(label) - 7))
    lines = [l.rstrip() for l in screen.display]
    while lines and not lines[-1]:
        lines.pop()
    print("\n".join(lines))

for step in steps:
    cmd, _, arg = step.partition(" ")
    if cmd == "wait":
        pump(float(arg))
    elif cmd == "keys":
        os.write(fd, codecs.decode(arg, "unicode_escape").encode())
        pump(0.15)
    elif cmd == "shot":
        shot(arg)
    elif cmd == "exited":
        done, status = os.waitpid(pid, os.WNOHANG)
        print(f"===== exited: {'yes, code ' + str(os.waitstatus_to_exitcode(status)) if done else 'no, still running'}")
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
