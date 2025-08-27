# Visual Novel Chat Standing Manager Fix

## Summary of Changes

This fix addresses remote sync issues in the visual-novel-chat module's standing-manager implementation where broadcasts were not emitted when users re-selected the same emotion and where receiving clients lacked characterData.

## Key Improvements

### 1. Enhanced `showStanding` Method (scripts/standing-manager.js)

**Added Parameters:**
- `fromSocket`: Indicates call is from network sync
- `forceUpdate`: Forces update even if emotion is same
- `fromUserAction`: Indicates direct user interaction

**Character Data Synthesis:**
- When `characterData[characterId]` is missing but call is from network sync, force update, or user action
- Synthesizes character data from `game.actors` using:
  - `actor.name` for character name
  - `actor.prototypeToken.texture.src` or `actor.img` as fallback image
  - Caches synthesized data to prevent repeated synthesis

**Emotion Resolution with Fallbacks:**
1. Explicit `characterData[emotion]`
2. 'default' emotion key
3. Any available emotion key  
4. Actor image fallback

**Forced Broadcast on Re-selection:**
- When user re-selects same emotion (no visual change), emits `emotionUpdate` broadcast
- Ensures other clients are notified even without visual change

**Optional Chaining & Guards:**
- Added comprehensive optional chaining (`?.`) throughout
- Guards against missing functions/members to prevent runtime errors

**Secure DOM Creation:**
- Uses `Handlebars.Utils.escapeExpression` for all DOM insertions
- Prevents XSS vulnerabilities

### 2. Enhanced Socket Handler (scripts/standing-manager.js)

**Added `emotionUpdate` Message Type:**
- Handles forced emotion updates from re-selection
- Calls `showStanding` with `forceUpdate: true`

### 3. Updated User Action Calls

**Modified Calls to Pass `fromUserAction: true`:**
- Emotion toggle button clicks
- Quick dock interactions  
- Emotion manager actions
- Chat command `/standing`

### 4. Debug Logging

**Added `_debug` Method:**
- Logs when debug mode is enabled in settings
- Provides detailed information for troubleshooting
- Tracks character data synthesis and broadcast decisions

## Files Modified

1. **scripts/standing-manager.js**
   - Enhanced `showStanding` method with robust fallbacks and sync handling
   - Added `_debug` method for improved troubleshooting
   - Updated `_onSocket` to handle `emotionUpdate` messages
   - Updated user interaction calls to pass `fromUserAction: true`

2. **scripts/main.js**  
   - Updated `/standing` chat command to pass `fromUserAction: true`

## Backward Compatibility

- All existing functionality is preserved
- New parameters are optional with sensible defaults
- Existing calling code continues to work without modification
- Module structure and exports remain unchanged

## Testing

The implementation was tested with comprehensive scenarios:
- ✅ Character data synthesis for missing data
- ✅ Forced broadcast on emotion re-selection  
- ✅ Network sync with missing data
- ✅ Preserved behavior for normal calls

## Result

The fix resolves the remote sync issues where:
1. Broadcasts are not emitted when a user re-selects the same emotion
2. Receiving clients lack characterData and fail to display standings
3. Missing robust fallbacks for emotion resolution

The solution is conservative, only altering the `showStanding` logic while maintaining the existing file structure and API compatibility.