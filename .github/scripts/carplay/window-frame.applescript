-- The Simulator's CarPlay window, raised: prints "x y width height" in screen points (top-left origin, as CGEvent).
-- The window whose name has "CarPlay", else the one that isn't the iPhone's. Prints every window's name to stderr.
on run
	tell application "Simulator" to activate
	tell application "System Events"
		tell process "Simulator"
			set frontmost to true
			set windowNames to name of every window
			set AppleScript's text item delimiters to ", "
			log "Simulator windows: " & (windowNames as text)
			set target to missing value
			repeat with candidate in windows
				if name of candidate contains "CarPlay" then set target to candidate
			end repeat
			if target is missing value then
				repeat with candidate in windows
					if name of candidate does not start with "iPhone" then set target to candidate
				end repeat
			end if
			if target is missing value then error "No CarPlay window among: " & (windowNames as text)
			perform action "AXRaise" of target
			set {x, y} to position of target
			set {w, h} to size of target
			return (x as integer as text) & " " & (y as integer as text) & " " & (w as integer as text) & " " & (h as integer as text)
		end tell
	end tell
end run
