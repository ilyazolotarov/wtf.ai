-- Turns on the Simulator's CarPlay display: I/O › External Displays › CarPlay (docs/CARPLAY-SPEC.md §6.2).
-- No simctl command does it. GitHub's macOS images give /usr/bin/osascript Accessibility and System Events.
-- Prints the menu's items, so a renamed one shows in the log.
on run
	tell application "Simulator" to activate
	delay 2
	tell application "System Events"
		tell process "Simulator"
			set frontmost to true
			set displaysMenu to menu 1 of menu item "External Displays" of menu 1 of menu bar item "I/O" of menu bar 1
			set itemNames to {}
			repeat with entry in menu items of displaysMenu
				set entryName to name of entry
				if entryName is not missing value then set end of itemNames to entryName
			end repeat
			set AppleScript's text item delimiters to ", "
			log "External Displays: " & (itemNames as text)
			repeat with entry in menu items of displaysMenu
				if name of entry is "CarPlay" then
					click entry
					return "CarPlay display on"
				end if
			end repeat
			error "No \"CarPlay\" in I/O › External Displays: " & (itemNames as text)
		end tell
	end tell
end run
