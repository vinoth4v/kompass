This function should return the last N lines of a file but drops one line. Find and fix the bug:
def tail(path, n):
lines = open(path).readlines()
return lines[-n+1:]
