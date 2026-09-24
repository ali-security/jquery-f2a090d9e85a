/*
 * Headless runner for the jQuery QUnit browser suite (test/index.html).
 *
 * Used by .travis.yml to actually execute the unit tests in a real browser
 * (grunt's default task only builds and lints). Requires a modern Node
 * (>= 18) and puppeteer-core resolvable via require() (e.g. installed into a
 * throwaway prefix and exposed with NODE_PATH), plus a Chrome/Chromium binary.
 *
 * Usage:
 *   NODE_PATH=/tmp/runner/node_modules \
 *     node test/run-browser-tests.js http://localhost:9876/test/index.html
 *
 * Environment:
 *   CHROME_BIN         path to the Chrome/Chromium executable (auto-detected otherwise)
 *   TEST_TIMEOUT_MIN   global timeout in minutes (default 20); exceeding it fails the run
 *
 * Prints one line per test, assertion details for every failure, a per-module
 * summary and a final "Tests: N passed, M failed, T total" line. Exits 0 only
 * if every test ran and none failed.
 */
"use strict";

var childProcess = require( "child_process" );
var fs = require( "fs" );
var puppeteer = require( "puppeteer-core" );

var url = process.argv[ 2 ];
var timeoutMin = parseFloat( process.env.TEST_TIMEOUT_MIN || "20" );

if ( !url ) {
	console.error( "Usage: node test/run-browser-tests.js <url of test/index.html>" );
	process.exit( 2 );
}

function findChrome() {
	var candidates = [ "google-chrome-stable", "google-chrome", "chromium-browser", "chromium" ];
	var i, out;

	if ( process.env.CHROME_BIN ) {
		return process.env.CHROME_BIN;
	}
	for ( i = 0; i < candidates.length; i++ ) {
		try {
			out = childProcess.execSync( "command -v " + candidates[ i ],
				{ stdio: [ "ignore", "pipe", "ignore" ] } ).toString().trim();
			if ( out && fs.existsSync( out ) ) {
				return out;
			}
		} catch ( e ) {}
	}
	throw new Error( "No Chrome/Chromium found; set CHROME_BIN" );
}

// Installed in the page before any page script runs. Hooks QUnit's logging
// callbacks the moment qunit.js assigns window.QUnit, i.e. before testinit.js
// loads the units and before QUnit.start() (autostart is disabled by testinit).
function pageHook() {
	if ( window !== window.top ) {
		return;
	}
	var qunit;
	function dump( value ) {
		try {
			return qunit.jsDump.parse( value );
		} catch ( e ) {
			return String( value );
		}
	}
	function send( type, data ) {
		window.__qunitReport( JSON.stringify( { type: type, data: data } ) );
	}
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return qunit;
		},
		set: function( value ) {
			qunit = value;
			if ( !value || value.__headlessHooked ) {
				return;
			}
			value.__headlessHooked = true;
			value.begin( function( d ) {
				send( "begin", { totalTests: d && d.totalTests } );
			} );
			value.log( function( d ) {
				if ( d.result ) {
					return;
				}
				send( "fail", {
					module: d.module,
					name: d.name,
					message: d.message,
					expected: "expected" in d ? dump( d.expected ) : undefined,
					actual: "actual" in d ? dump( d.actual ) : undefined,
					source: d.source
				} );
			} );
			value.testDone( function( d ) {
				send( "testDone", {
					module: d.module,
					name: d.name,
					failed: d.failed,
					passed: d.passed,
					total: d.total,
					duration: d.duration
				} );
			} );
			value.moduleDone( function( d ) {
				send( "moduleDone", d );
			} );
			value.done( function( d ) {
				send( "done", d );
			} );
		}
	} );
}

function main() {
	var browser, page, timer;
	var tests = { passed: 0, failed: 0 };
	var modules = {};
	var moduleOrder = [];
	var pendingFailures = [];
	var finished = false;

	function finish( code, reason ) {
		if ( finished ) {
			return;
		}
		finished = true;
		clearTimeout( timer );
		if ( reason ) {
			console.log( "\nRUN ABORTED: " + reason );
		}
		var closing = browser ? browser.close().catch( function() {} ) : Promise.resolve();
		closing.then( function() {
			process.exit( code );
		} );
	}

	function handle( msg ) {
		var ev = JSON.parse( msg );
		var d = ev.data;
		var m, i, f;

		if ( ev.type === "begin" ) {
			console.log( "QUnit started" + ( d.totalTests ? " (" + d.totalTests + " tests)" : "" ) );
		} else if ( ev.type === "fail" ) {
			pendingFailures.push( d );
		} else if ( ev.type === "testDone" ) {
			if ( !modules[ d.module ] ) {
				modules[ d.module ] = { passed: 0, failed: 0, assertions: 0, failedAssertions: 0 };
				moduleOrder.push( d.module );
			}
			m = modules[ d.module ];
			m.assertions += d.total;
			m.failedAssertions += d.failed;
			if ( d.failed > 0 ) {
				m.failed++;
				tests.failed++;
			} else {
				m.passed++;
				tests.passed++;
			}
			console.log( ( d.failed > 0 ? "FAIL" : "PASS" ) + " [" + d.module + "] " + d.name +
				" (" + d.passed + "/" + d.total + " assertions, " + d.duration + "ms)" );
			for ( i = 0; i < pendingFailures.length; i++ ) {
				f = pendingFailures[ i ];
				console.log( "    - " + ( f.message || "(no message)" ) );
				if ( f.expected !== undefined || f.actual !== undefined ) {
					console.log( "      expected: " + f.expected );
					console.log( "      actual:   " + f.actual );
				}
				if ( f.source ) {
					console.log( "      at: " + String( f.source ).split( "\n" ).slice( 0, 3 )
						.join( "\n          " ) );
				}
			}
			pendingFailures = [];
		} else if ( ev.type === "moduleDone" ) {
			console.log( "Module [" + d.name + "]: " + d.passed + " passed, " + d.failed +
				" failed assertions (" + d.total + " total)" );
		} else if ( ev.type === "done" ) {
			console.log( "\n==== Summary per module ====" );
			moduleOrder.forEach( function( name ) {
				var s = modules[ name ];
				console.log( "  " + name + ": " + s.passed + " passed, " + s.failed + " failed, " +
					( s.passed + s.failed ) + " total tests (assertions: " +
					( s.assertions - s.failedAssertions ) + " passed, " + s.failedAssertions +
					" failed)" );
			} );
			console.log( "\nTests: " + tests.passed + " passed, " + tests.failed + " failed, " +
				( tests.passed + tests.failed ) + " total (assertions: " + d.passed + " passed, " +
				d.failed + " failed, " + d.total + " total) in " + d.runtime + "ms" );
			if ( tests.failed === 0 && d.failed === 0 && tests.passed > 0 ) {
				finish( 0 );
			} else {
				finish( 1 );
			}
		}
	}

	timer = setTimeout( function() {
		finish( 1, "global timeout of " + timeoutMin + " minutes exceeded" );
	}, timeoutMin * 60 * 1000 );

	return puppeteer.launch( {
		executablePath: findChrome(),
		headless: true,
		args: [ "--no-sandbox", "--disable-dev-shm-usage" ]
	} ).then( function( b ) {
		browser = b;
		browser.on( "disconnected", function() {
			finish( 1, "browser disconnected" );
		} );
		return browser.newPage();
	} ).then( function( p ) {
		page = p;
		page.on( "pageerror", function( err ) {
			console.log( "[page error] " + ( err && err.message || err ) );
		} );
		page.on( "error", function( err ) {
			finish( 1, "page crashed: " + err );
		} );
		page.on( "dialog", function( dialog ) {
			console.log( "[dialog] " + dialog.type() + ": " + dialog.message() );
			dialog.dismiss().catch( function() {} );
		} );
		return page.exposeFunction( "__qunitReport", handle );
	} ).then( function() {
		return page.evaluateOnNewDocument( pageHook );
	} ).then( function() {
		// The test server may have just been started in the background; retry
		// connection failures for a short while before giving up.
		function open( attempt ) {
			console.log( "Opening " + url + ( attempt > 1 ? " (attempt " + attempt + ")" : "" ) );
			return page.goto( url, { waitUntil: "load", timeout: 120000 } ).catch( function( err ) {
				if ( attempt < 30 && /ERR_CONNECTION_REFUSED/.test( String( err && err.message ) ) ) {
					return new Promise( function( resolve ) {
						setTimeout( resolve, 1000 );
					} ).then( function() {
						return open( attempt + 1 );
					} );
				}
				throw err;
			} );
		}
		return open( 1 );
	} ).then( function( response ) {
		if ( !response || !response.ok() ) {
			finish( 1, "could not load " + url + " (status " +
				( response && response.status() ) + ")" );
		}
	} ).catch( function( err ) {
		finish( 1, err && err.stack || String( err ) );
	} );
}

main();
