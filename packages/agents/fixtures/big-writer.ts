import { writeStdoutAndExit } from '../src/measure/drain'

// Test child: prints argv[2] bytes of 'x' through the same write-and-exit helper the match child uses.
writeStdoutAndExit('x'.repeat(Number(process.argv[2])))
