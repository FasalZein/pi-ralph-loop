const USAGE = "Usage: ralph launch|watch|stop|status <root> (not implemented yet)";

/** Print usage for the watch command skeleton. */
export function main(argv: readonly string[]): number {
	if (argv.length === 0 || (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help"))) {
		console.log(USAGE);
		return 0;
	}
	console.error(USAGE);
	return 2;
}
