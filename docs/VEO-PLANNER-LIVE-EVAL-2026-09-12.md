# Живой прогон планировщика, 12 сентября 2026

| Тема | Сцен | Покрытие | Оценка Veo | Вызовов | Второй заход | Запреты | План, $ |
|---|---|---|---|---|---|---|---|
| Apple, iPhone Duo | 6 | 47% | $3.84 | 2 | принят | phase-conflict | 0.1976 |
| Трамп и могила на поле для гольфа | 6 | 55% | $3.68 | 2 | отклонён | required-anchor-outside-shot | 0.2073 |
| Машина времени Николы Теслы | 7 | 56% | $4.16 | 2 | принят | cut-inside-shot | 0.2329 |
| Биржа против холодного кошелька | 6 | 39% | $3.84 | 2 | отклонён | readable-text | 0.2374 |

Итого на планы: $0.8752. Veo и картинки не запускались.

## Apple, iPhone Duo

Речь 84 с, сцен 6, покрытие 47%, оценка Veo $3.84.

### События контракта

- `duo-fold` (обязательное): the phone is shown folding shut like a book, hinge closing, two screens becoming one slab
  - duo-body [change]: open flat like a small tablet → folded shut like a closed book
- `screen-compare` (обязательное): outer cover screen and inner foldable screen are shown side by side or in sequence, sizes contrasted
  - cover-screen [change]: not shown → visible lit 5.4-inch cover display
  - inner-screen [change]: folded closed, hidden → unfolded and lit, 7.6-inch display fully open
- `no-faceid` (обязательное): the phone is held up to a face for Face ID and it fails/is absent, cutting to the side button being pressed instead
  - unlock-method [change]: expected Face ID scan at the top of the screen → thumb pressing the side-mounted Touch ID button, screen unlocks
- `pencil-draw` (обязательное): a white USB-C Apple Pencil touches the open inner screen and a line is drawn
  - pencil [change]: resting beside the phone, not touching screen → tip in contact with the screen, a drawn line visible
- `camera-zoom` (обязательное): the rear dual 48MP camera module is shown, then the main camera visibly zooms in 2x on a subject through the viewfinder
  - camera-module [change]: wide framing on viewfinder, no zoom indicator → framing tightened to 2x zoom on the same subject

### Сцены

**B1 · 0.0–4.0 с · eye_level · medium** — события: []
- действие: Gudini's hands set a closed black foldable phone with a visible hinge down on a light-grey studio table, phone catching the light.
- ключевой момент: the closed foldable phone lands on the table and light glints off its hinge
- движение: Hands lower the closed phone onto the table surface; phone settles flat; camera holds steady on the reveal.
- механика: hands descend and set the phone down; phone makes contact with table, slight settle motion
- реквизит: the black closed iPhone Duo foldable phone
- расстановка: Gudini's hands only, placing the phone
- камера: Camera is at table height, about one meter back; hands enter frame from above and lower the phone straight down onto the table.
- объекты: duo-body [change]: held above the table, not yet placed → resting closed on the table surface

**B3 · 8.3–12.0 с · eye_level · medium** — события: ["duo-fold"]
- действие: Gudini holds the phone open flat like a small tablet, then his hands fold it closed, the hinge rotating the two halves together into one slab.
- ключевой момент: the hinge closes and the two open halves come together into a single closed slab
- движение: Phone starts open flat in both hands; hands rotate the two halves toward each other along the hinge; halves meet and the phone becomes one closed slab.
- механика: both hands grip opposite halves of the phone and rotate them toward each other around the central hinge until the halves meet flush
- реквизит: the black iPhone Duo foldable phone with visible hinge
- расстановка: Gudini holding the phone with both hands, folding it
- камера: Camera is directly in front at chest height, one meter back; Gudini's hands fold the halves toward each other, staying centered in frame.
- объекты: duo-body [change]: open flat like a small tablet → folded shut like a closed book

**B4 · 12.0–20.0 с · eye_level · medium_wide** — события: ["screen-compare"]
- действие: Gudini holds the phone closed with the small cover screen lit, then unfolds it fully, revealing the large inner foldable screen lit edge to edge.
- ключевой момент: the small lit cover screen gives way to the much larger lit inner screen as the phone unfolds
- движение: Phone starts closed with cover screen lit facing camera; hands unfold the halves apart; inner screen lights up fully open, much larger than the cover screen was.
- механика: phone starts closed showing the small lit cover screen facing camera; hands pull the two halves apart around the hinge until flat, revealing the larger lit inner screen
- реквизит: the black iPhone Duo foldable phone
- расстановка: Gudini holding the phone, first closed then unfolding it
- камера: Camera is in front at chest height, one meter back; hands unfold the phone open toward the camera, both screens staying in frame in sequence.
- объекты: cover-screen [change]: not shown → visible lit 5.4-inch cover display | inner-screen [change]: folded closed, hidden → unfolded and lit, 7.6-inch display fully open

**B6 · 29.4–37.4 с · eye_level · medium** — события: ["no-faceid"]
- действие: Gudini lifts the closed-then-open phone toward his face at eye level; the screen stays locked with no scan indicator; he then presses his thumb onto the side button and the screen unlocks.
- ключевой момент: the screen fails to unlock facing his face, then unlocks the instant his thumb presses the side button
- движение: Phone rises toward Gudini's face, screen stays dark and locked; phone lowers slightly; his thumb finds the side edge and presses the button; screen lights up unlocked.
- механика: phone is raised toward the face at the height where Face ID would scan; no unlock occurs; thumb moves to the side edge of the phone and presses a small button, triggering the unlock
- реквизит: the black iPhone Duo foldable phone
- расстановка: Gudini holding the phone up near his face, then pressing its side button with his thumb
- камера: Camera is in front at eye level, one meter back; phone rises toward camera near Gudini's face, then lowers as his thumb presses the side edge.
- объекты: unlock-method [change]: expected Face ID scan at the top of the screen → thumb pressing the side-mounted Touch ID button, screen unlocks

**B7 · 41.9–49.9 с · overhead · close** — события: ["pencil-draw"]
- действие: Gudini picks up the white USB-C Apple Pencil from beside the open phone and touches its tip to the lit inner screen, drawing a curved line as it moves.
- ключевой момент: the pencil tip makes contact with the screen and a line trails behind it as it moves
- движение: Pencil starts resting flat on the table beside the phone; hand lifts it and brings the tip down onto the open lit screen; tip drags across the screen leaving a drawn line.
- механика: pencil tip lowers onto the glass screen surface, then drags in a curved stroke while maintaining contact, leaving a visible drawn line on the display
- реквизит: the white USB-C Apple Pencil; the black iPhone Duo foldable phone open flat, inner screen lit
- расстановка: Gudini holding the phone open flat with one hand, drawing on it with the pencil in the other
- камера: Camera is directly above the table looking down at a slight angle, close to the screen; the pencil tip moves across frame left to right drawing the line.
- объекты: pencil [change]: resting beside the phone, not touching screen → tip in contact with the screen, a drawn line visible

**B8 · 54.4–62.4 с · eye_level · medium** — события: ["camera-zoom"]
- действие: Gudini turns the phone to show its back with two camera lenses, then raises it to frame a subject on the viewfinder screen, the framing tightening as he zooms to 2x.
- ключевой момент: the viewfinder image visibly tightens from a wide frame to a closer 2x-zoomed frame on the same subject
- движение: Phone's back with two lenses faces camera briefly; phone turns and rises to eye level, screen showing the viewfinder; the framed subject on screen grows closer as the zoom engages.
- механика: phone rotates to reveal the two rear lenses, then rotates back and rises toward eye level; the viewfinder on the phone's screen shows the framing narrowing as the main lens zooms in on the subject
- реквизит: the black iPhone Duo foldable phone with two 48MP rear lenses visible on the back
- расстановка: Gudini turning the phone to show its back, then holding it up to frame a shot
- камера: Camera is in front at eye level, one meter back; the phone rotates to show its back, then rises toward the camera as the viewfinder framing tightens.
- объекты: camera-module [change]: wide framing on viewfinder, no zoom indicator → framing tightened to 2x zoom on the same subject

### Замечания проверок

- `location-jump-back` warn: Действие возвращается в прежнее место через сцену — проверьте порядок событий (B7, B8)
- `phase-conflict` block: Сцена начинается с предмета в исходном состоянии, а камера уже описывает его конечное состояние (B4/cover-screen, B4/inner-screen)
- `author-stretch-long` warn: Длинные куски без сцен (больше 12 с): 62.4–84.5 с

## Трамп и могила на поле для гольфа

Речь 81 с, сцен 6, покрытие 55%, оценка Veo $3.68.

### События контракта

- `burial` (обязательное): Ivana's grave is established on the golf course near the clubhouse
  - grave-plot [change]: open grass near the clubhouse, no marker → a plain granite headstone standing on the grass plot
- `cemetery-claim-rejected` (обязательное): the cemetery tax-exemption claim is shown not to apply to the golf course
  - cemetery-exemption-status [change]: assumed by the public to apply to the whole course → explained as not applying, based on available records
- `farm-designation` (обязательное): part of the estate is shown functioning as a working farm with goats and mown hay, separate from the golf course
  - farm-plot [change]: part of the golf estate with no distinct agricultural use shown → a fenced pasture with goats grazing and mown hay bales
- `tax-gap` (обязательное): the enormous gap between the farm tax bill and the hypothetical golf-course tax bill is shown side by side
  - tax-bill [change]: unclear to the viewer → shown as a small farm tax figure next to a much larger hypothetical golf-course figure

### Сцены

**B1 · 0.0–8.0 с · ground_level · medium_wide** — события: ["burial"]
- действие: Gudini, playing Trump, stands solemnly a few steps from a small grass plot near the golf course; a plain grey granite headstone is being set upright into the ground by two groundskeepers while he watches, the clubhouse visible in the background across the fairway.
- ключевой момент: the headstone is lowered upright into the grass plot, visibly marking the grave for the first time
- движение: Camera is at ground level about four meters from the plot; two groundskeepers lower the grey granite headstone into a shallow prepared slot in the grass while Gudini stands nearby watching in silence; the camera holds still as the stone settles upright.
- механика: the groundskeepers guide the headstone's base into the slot and it settles upright, becoming a fixed marker on the grass
- реквизит: the plain grey granite headstone; a shallow prepared slot in the grass
- расстановка: Gudini as Trump stands a few steps back on the grass; two groundskeepers kneel at the plot setting the headstone
- камера: Camera is at ground level about four meters from the grass plot, roughly at chest height; the groundskeepers lower the headstone straight down into the slot while Gudini stands still to the side.
- объекты: grave-plot [change]: open grass near the clubhouse, no marker → a plain granite headstone standing upright on the grass plot

**B3 · 16.9–22.1 с · eye_level · wide** — события: []
- действие: A wide static shot of an ordinary small cemetery with rows of plain headstones on mown grass, no people, representing the type of land the exemption applies to.
- ключевой момент: the rows of ordinary headstones establish what a tax-exempt cemetery plot looks like
- движение: Camera is static, thirty meters back at eye level; nothing moves except a light breeze through the grass; the rows of headstones remain still across the frame.
- механика: static wide shot establishing the setting, no action
- реквизит: rows of plain grey headstones; mown grass
- расстановка: no people in frame
- камера: Camera is static thirty meters back at eye level, framing rows of headstones across the middle of the frame.
- объекты: cemetery-rows [keep]: not shown yet → rows of plain headstones visible on mown grass

**B4 · 22.1–30.1 с · eye_level · medium** — события: ["cemetery-claim-rejected"]
- действие: A man in his forties sits at a cluttered desk with printed tax documents, tapping one page and shaking his head slightly while speaking, a satellite-style printout of the golf course visible on the desk beside him.
- ключевой момент: he taps the printout of the golf course map and shakes his head, visibly rejecting the exemption claim
- движение: Camera is at desk height about two meters away; the man taps his finger twice on the printed course map, then leans back and shakes his head slightly; the camera holds steady throughout.
- механика: his tapping finger on the map and the head shake are the visible signal that the exemption claim is being dismissed
- реквизит: printed tax documents; a printed aerial map of the golf course
- расстановка: the Bloomberg Tax author sits at his desk, facing slightly off camera, one hand on the documents
- камера: Camera is at desk height about two meters from the man, facing him slightly off-axis; he taps the printed map twice and leans back.
- объекты: cemetery-exemption-status [change]: assumed by the public to apply to the whole course → explained as not applying, based on available records

**B6 · 40.9–48.6 с · eye_level · medium_wide** — события: ["farm-designation"]
- действие: Gudini, playing Trump, walks slowly along a wire fence bordering a pasture; a small herd of brown and white goats graze behind the fence, and round mown hay bales sit in the field beyond them.
- ключевой момент: the goats and hay bales come fully into view as Gudini walks past the fence, establishing the farm use of the land
- движение: Camera is beside the wire fence at chest height; Gudini walks across frame left to right along the fence line, the goats grazing steadily behind the wire and the mown hay bales visible in the field beyond as he passes.
- механика: the fence separates Gudini from the goats; his walking pace reveals the pasture and hay bales progressively as the camera holds on the fence line
- реквизит: a wire fence; brown and white goats; round mown hay bales
- расстановка: Gudini walks along the outside of the fence, glancing at the goats
- камера: Camera is beside the wire fence at chest height, static; Gudini walks across frame left to right along the fence with the goats and hay bales visible behind the wire.
- объекты: farm-plot [change]: part of the golf estate with no distinct agricultural use shown → a fenced pasture with goats grazing and mown hay bales

**B7 · 48.6–56.3 с · eye_level · medium** — события: []
- действие: A closer static shot of the mown hay field with round bales and goats in the background, no people, representing the documented agricultural use required by New Jersey rules.
- ключевой момент: the hay bales and goats sit together in frame, visually confirming genuine farm activity rather than a golf course
- движение: Camera is static about ten meters from the nearest hay bale at eye level; goats continue grazing in the middle distance, nothing else moves in the frame.
- механика: static shot, goats continue grazing, confirming ongoing farm use
- реквизит: round mown hay bales; grazing goats; wire fence
- расстановка: no people in frame
- камера: Camera is static about ten meters from the nearest hay bale at eye level, holding on the bales with goats grazing behind them.
- объекты: farm-plot [keep]: a fenced pasture with goats grazing and mown hay bales → a fenced pasture with goats grazing and mown hay bales

**B8 · 56.3–64.3 с · high_angle · close** — события: ["tax-gap"]
- действие: A hand places a small printed tax bill showing a low dollar figure onto an open wooden ledger book, then places a second, visually thicker tax bill beside it representing the much larger hypothetical amount.
- ключевой момент: the second, larger tax bill is set down right next to the small one, making the size difference visible in a single frame
- движение: Camera is directly above the open ledger book at a slight angle; a hand places the small farm tax bill down first, then a hand places the noticeably thicker hypothetical golf-course tax bill right beside it, both remaining in frame together.
- механика: the hand sets the small bill down first, then places the visibly larger bill directly beside it, creating a side-by-side size contrast
- реквизит: a small printed farm tax bill; a thicker hypothetical golf-course tax bill; an open wooden ledger book
- расстановка: only a hand is visible, placing documents
- камера: Camera is directly above the ledger book at a slight angle, close enough to read the size difference; a hand places both documents down in sequence.
- объекты: tax-bill [change]: unclear to the viewer → shown as a small farm tax bill next to a much larger hypothetical golf-course tax bill

### Замечания проверок

- `required-anchor-outside-shot` block: Обязательное событие звучит позже, чем заканчивается его клип — сцену нужно переставить под свою реплику (B8)
- `object-state-describes-person` warn: Состояние предмета описывает позу человека, а не сам предмет — положение людей относится к сцене, а не к вещи (B1)
- `author-stretch-long` warn: Длинные куски без сцен (больше 12 с): 64.3–80.8 с

## Машина времени Николы Теслы

Речь 82 с, сцен 7, покрытие 56%, оценка Veo $4.16.

### События контракта

- `lab-fire` (обязательное): Tesla's New York laboratory burns and is destroyed by fire
  - laboratory [change]: intact wooden building filled with electrical apparatus → engulfed in flames and smoke, structure collapsing
- `tesla-death` (обязательное): Tesla dies alone in his New York hotel room
  - tesla-body [change]: alive, lying in hotel bed → deceased, still in the hotel room
- `papers-seized` (обязательное): government agents take Tesla's papers from his hotel room after his death
  - tesla-papers [change]: stacked personal papers in the hotel room → packed into sealed government boxes and removed
- `trump-review` (обязательное): John Trump examines Tesla's papers and finds no new workable principles
  - tesla-papers [change]: sealed boxes of documents on a desk → opened and reviewed, assessed as containing no new workable science
- `boat-demo`: Tesla demonstrates a radio-controlled boat model
  - toy-boat [change]: motionless on the water surface → moving across the water under remote control
- `tower-transmission`: the Wardenclyffe tower is shown attempting wireless energy transmission
  - wardenclyffe-tower [change]: standing dark and idle → crackling with visible electrical discharge at its dome

### Сцены

**B1 · 0.0–7.7 с · eye_level · medium** — события: []
- действие: Gudini as Tesla stands in his lab surrounded by arcing electrical coils, illuminated by blue-white sparks, staring at the equipment.
- ключевой момент: A bright electric arc jumps between two coils, lighting up Tesla's face.
- движение: Camera holds steady in front of the coil apparatus; an electrical arc jumps between two terminals; Gudini as Tesla stands still, watching the sparks with intent focus.
- механика: the lever is pulled, current flows into the coil, and an arc jumps visibly between two terminal points
- реквизит: large Tesla coil apparatus; brass control switches
- расстановка: Gudini as Tesla stands facing large electrical coils, hands near a control lever
- камера: Camera is static at eye level three meters from the coil apparatus; the electrical arc jumps between the terminals as Gudini stands motionless watching it.
- объекты: tesla-coil [change]: dormant, no visible current → arcing with bright electrical discharge

**B2 · 7.7–15.6 с · eye_level · medium_wide** — события: ["lab-fire"]
- действие: Gudini as Tesla stands helplessly in the doorway of his wooden laboratory as flames spread rapidly through the room, consuming the electrical apparatus and shelves.
- ключевой момент: Flames engulf the wooden shelves and equipment, smoke fills the room, and the structure begins to collapse.
- движение: Fire spreads across wooden shelving and equipment; smoke thickens and rises; part of the ceiling beam cracks and falls; Gudini as Tesla steps back from the heat, shielding his face.
- механика: fire spreads along dry wooden shelving, heat causes a ceiling beam to crack and fall, smoke fills the upper part of the room
- реквизит: wooden shelves with glass jars and coils; a falling ceiling beam
- расстановка: Gudini as Tesla stands in the doorway, backing away from the spreading fire
- камера: Camera is positioned just outside the doorway at eye level; fire spreads across the shelves in the background as Gudini backs toward the camera.
- объекты: laboratory [change]: intact wooden building filled with electrical apparatus → engulfed in flames and smoke, structure collapsing

**B4 · 30.3–35.4 с · eye_level · medium** — события: ["tesla-death"]
- действие: Gudini as an elderly Tesla lies motionless in the hotel bed; the room is still, curtains drawn, no one else present, showing the transition from life to death.
- ключевой момент: Tesla's chest, which was faintly rising with breath, goes still; his hand slackens on the blanket.
- движение: Gudini as Tesla lies in the hotel bed, his chest rising faintly with a slow breath; the breathing stops, his hand slackens and falls open on the blanket; the room remains still and silent.
- механика: his breathing visibly slows and stops, his open hand goes slack on the blanket, no external cause, natural stillness settles over the body
- реквизит: hotel bed with worn blanket; a bedside table with a glass of water
- расстановка: Gudini as elderly Tesla lies alone in the hotel bed, no one else in the room
- камера: Camera is at the foot of the bed at eye level; Tesla's chest rises once faintly then stops, his hand slackening on the blanket.
- объекты: tesla-body [change]: alive, lying in hotel bed → deceased, still in the hotel room

**B5 · 35.4–37.9 с · eye_level · medium** — события: ["papers-seized"]
- действие: Two men in dark overcoats pack Tesla's stacked personal papers from the hotel desk into sealed boxes and carry them out of the room.
- ключевой момент: The last stack of papers on the desk is placed into a box, which is then sealed shut and lifted away.
- движение: One agent lifts the stacked papers from the desk and places them into an open box; the other agent closes the box lid and seals it with tape; both agents carry the sealed boxes toward the door.
- механика: papers are lifted by hand from the desk stack into the box, the box lid is closed and taped shut, then carried out
- реквизит: stacked personal papers on the desk; open cardboard boxes; sealing tape
- расстановка: two government agents stand at the desk, packing papers into boxes
- камера: Camera is by the window at eye level facing the desk; one agent packs the papers into the box while the other seals it and both move toward the door.
- объекты: tesla-papers [change]: stacked personal papers in the hotel room → packed into sealed government boxes and removed

**B6 · 37.9–45.9 с · eye_level · medium** — события: ["trump-review"]
- действие: John Trump sits at a desk covered with the sealed boxes, opens one, pulls out a stack of documents, reads through them, and sets them aside with a neutral, unimpressed expression.
- ключевой момент: Trump closes the folder of documents and pushes it aside, shaking his head slightly, having found nothing new.
- движение: Trump cuts the tape on a sealed box and opens the lid; he lifts out a stack of papers and reads through several pages; he closes the folder and pushes it to the side of the desk, shaking his head slightly.
- механика: the box seal is cut open, papers are lifted out and read, then set aside closed, showing the review reaching its conclusion
- реквизит: sealed government boxes on the desk; loose stacks of documents; a desk lamp
- расстановка: John Trump sits alone at the desk, reviewing the opened papers
- камера: Camera is across the desk at eye level; Trump opens the box, reads the papers, then closes the folder and pushes it aside.
- объекты: tesla-papers [change]: sealed boxes of documents on a desk → opened and reviewed, assessed as containing no new workable science

**B8 · 64.2–71.3 с · eye_level · medium_wide** — события: []
- действие: Gudini as Tesla stands beside the coil transformer as it hums with electricity, small arcs of current visibly running along the coil.
- ключевой момент: A steady electric current visibly runs along the coil's surface, showing the transformer actively working.
- движение: The coil hums and a thin electrical current runs visibly along its winding; Gudini as Tesla stands beside it observing with quiet satisfaction.
- механика: the coil is switched on and current visibly travels along its winding as a thin glowing line
- реквизит: the working Tesla coil transformer apparatus
- расстановка: Gudini as Tesla stands beside the coil, one hand resting near the base
- камера: Camera is level with the coil apparatus at a slight distance; the current runs visibly along the coil as Gudini stands beside it watching.
- объекты: tesla-transformer-coil [change]: static and powered off → actively running with visible current along its coil

**B9 · 71.3–78.4 с · eye_level · medium_wide** — события: ["boat-demo","tower-transmission"]
- действие: Gudini as Tesla stands at the edge of a pond, controlling a small metal-hulled boat that moves across the water by remote signal; the shot then shows the wooden Wardenclyffe Tower with its metal dome crackling with electricity.
- ключевой момент: The small boat visibly turns and moves across the water under remote control, then the tower's dome bursts with a crackling electrical discharge.
- движение: Gudini as Tesla holds a control box on the pond's edge; the small boat's rudder turns and it moves across the water in response; cut to the Wardenclyffe Tower where the metal dome crackles with a burst of electrical discharge arcing upward into the sky.
- механика: the control box sends a signal that turns the boat's rudder and drives it forward across the water; separately, current builds in the tower and discharges as visible crackling arcs from the dome
- реквизит: the small metal-hulled radio-controlled boat; a handheld control box with an antenna; the wooden Wardenclyffe tower with its metal dome
- расстановка: Gudini as Tesla stands at the pond's edge holding a control box, then is shown near the base of the tower watching it discharge
- камера: Camera is at the pond's edge at eye level for the boat, then repositions low in front of the tower looking up as the dome discharges electricity.
- объекты: toy-boat [change]: motionless on the water surface → moving across the water under remote control | wardenclyffe-tower [change]: standing dark and idle → crackling with visible electrical discharge at its dome

### Замечания проверок

- `beat-multiple-events` warn: В одной сцене несколько событий: у них будет общий срок, показать их по отдельности нельзя — разложите на две сцены (B9)
- `object-state-describes-person` warn: Состояние предмета описывает позу человека, а не сам предмет — положение людей относится к сцене, а не к вещи (B4, B8, B9)
- `toward-lens-fixed-scale` warn: Объект движется в объектив, а камера неподвижна и обязана удержать масштаб — задайте отход камеры или движение мимо неё (B2)
- `author-stretch-long` warn: Длинные куски без сцен (больше 12 с): 15.6–30.3 с, 45.9–64.2 с
- `cut-inside-shot` block: Склейка внутри одной сцены (B9): Veo снимает один непрерывный кадр, монтаж внутри него невозможен (B9)

## Биржа против холодного кошелька

Речь 102 с, сцен 6, покрытие 39%, оценка Veo $3.84.

### События контракта

- `balance-shown` (обязательное): a balance figure is visible on an exchange account screen, implying coins are recorded there
  - balance-screen [change]: screen is off or blank → screen shows an account balance figure
- `withdraw-blocked` (обязательное): a withdrawal request is submitted on a phone and then blocked or held by the platform
  - withdraw-request [change]: not submitted → submitted and held/blocked, not completed
- `key-control-transfer` (обязательное): the hardware wallet signs a transfer internally without ever sending the private key to the connected laptop
  - hardware-wallet [change]: disconnected, screen off → connected, screen showing a signing confirmation
  - private-key [keep]: stored only inside the device → still stored only inside the device, never leaves it
- `recovery-restore` (обязательное): a new hardware wallet gains access after the recovery phrase card is entered into it
  - new-wallet [change]: blank, no wallet access → restored, showing the same wallet access
  - recovery-card [change]: unused, lying on the desk → read and entered into the device
- `total-loss` (обязательное): both the wallet device and the recovery phrase card are shown lost/destroyed, leaving no way back in
  - hardware-wallet [change]: functioning, holds the key → broken or missing
  - recovery-card [change]: kept safe → missing or destroyed
- `wallet-cant-be-frozen` (обязательное): the same hardware wallet completes a signed transfer on its own with no outside platform involved, contrasted with the earlier blocked exchange withdrawal
  - hardware-wallet [change]: idle → actively signs and completes a transfer unopposed
- `not-your-keys` (обязательное): a hand-drawn or symbolic contrast is shown of a key held in one's own hand versus a key locked inside someone else's box
  - key-own [change]: not yet held → held firmly in the owner's own hand
  - key-exchange [keep]: held by the platform → still held by the platform, out of owner's reach

### Сцены

**B1 · 0.0–4.5 с · eye_level · medium** — события: ["balance-shown"]
- действие: Gudini sits at a desk, opens a laptop, and looks at a balance figure glowing on the screen.
- ключевой момент: The balance number appears clearly on the laptop screen as Gudini leans in to look at it.
- движение: Gudini's hand taps the laptop trackpad; the screen wakes and an abstract balance figure appears; he leans slightly closer to read it.
- механика: tapping the trackpad wakes the screen; the balance figure fades into view
- реквизит: a laptop showing an abstract balance figure, no readable text
- расстановка: Gudini seated at the desk, facing the laptop screen
- камера: Camera is beside the desk at seated eye height, roughly a meter away; Gudini leans toward the laptop screen as it lights up.
- объекты: balance-screen [change]: screen is off or blank → screen shows an account balance figure

**B3 · 24.1–32.1 с · high_angle · close** — события: ["key-control-transfer"]
- действие: Gudini plugs the hardware wallet into the laptop with a short cable, presses a button on the device, and its tiny screen shows a signing confirmation.
- ключевой момент: The device's tiny screen lights up with a confirmation symbol the instant Gudini presses its button, while the laptop screen stays unchanged.
- движение: Gudini picks up the small black hardware wallet, plugs its cable into the laptop, presses the device's button with his thumb, and its tiny screen shows a confirmation; the laptop screen remains a simple pending request with no key data shown.
- механика: plugging the cable connects the device to the laptop; pressing the device's button triggers signing shown only on the device's own tiny screen
- реквизит: a small black hardware wallet device with a tiny screen and two buttons; a laptop showing a simple pending-request screen; a short USB cable
- расстановка: Gudini seated at the desk, hands on the hardware wallet and the cable
- камера: Camera is close over the desk at a slight downward angle; Gudini's hands bring the hardware wallet into frame and press its button toward the camera.
- объекты: hardware-wallet [change]: disconnected, screen off → connected, screen showing a signing confirmation | private-key [keep]: stored only inside the device → still stored only inside the device, never leaves it

**B4 · 32.7–39.5 с · eye_level · close** — события: ["recovery-restore"]
- действие: Gudini picks up a paper card with handwritten words, reads it while entering the words into a new hardware wallet device, whose screen then shows a restored wallet.
- ключевой момент: The new device's screen switches from a blank setup prompt to a restored wallet view as the last word from the card is entered.
- движение: Gudini lifts the handwritten paper card, glances between it and the new device, presses its buttons to enter each word, and the device's screen changes to show restored access.
- механика: reading each word from the card and pressing it into the device restores the wallet on the new device's screen
- реквизит: a handwritten paper card with a row of blurred handwritten words; a new small black hardware wallet device with a blank setup screen
- расстановка: Gudini seated at the desk, holding the recovery card in one hand and the new device in the other
- камера: Camera is close over the desk at eye height with the device and card both visible; Gudini's hands move the card and device toward the camera as he enters the words.
- объекты: new-wallet [change]: blank, no wallet access → restored, showing the same wallet access | recovery-card [change]: unused, lying on the desk → read and entered into the device

**B5 · 39.5–46.2 с · high_angle · close** — события: ["total-loss"]
- действие: Gudini sets down a cracked hardware wallet device next to a torn recovery phrase card, looking at both with no way to proceed.
- ключевой момент: Both the cracked device and the torn card are visible together on the desk in the same frame, showing both paths gone at once.
- движение: Gudini places the cracked device on the desk, then sets the torn recovery card beside it, and pauses looking at both.
- механика: placing the cracked device and torn card side by side shows both means of recovery are gone simultaneously
- реквизит: a cracked small black hardware wallet device; a torn handwritten paper card
- расстановка: Gudini seated at the desk, setting down both broken items
- камера: Camera is close over the desk at a slight downward angle; Gudini's hands set the cracked device and torn card down into frame side by side.
- объекты: hardware-wallet [change]: functioning, holds the key → broken or missing | recovery-card [change]: kept safe → missing or destroyed

**B6 · 46.2–54.2 с · eye_level · close** — события: ["withdraw-blocked","wallet-cant-be-frozen"]
- действие: Gudini submits a withdrawal on his smartphone and the screen shows the request stuck pending; then he presses the hardware wallet's button and it completes a signature immediately with no outside approval needed.
- ключевой момент: The phone's withdrawal status stays stuck on pending while, moments later, the hardware wallet's screen shows a completed signature with no waiting.
- движение: Gudini taps the phone screen to submit a withdrawal, the status shows a spinning pending indicator; he sets the phone down and picks up the hardware wallet, presses its button, and its screen shows a completed confirmation right away.
- механика: tapping submit on the phone triggers a pending state that does not resolve; pressing the wallet's button triggers an immediate completed signature with no external approval step
- реквизит: a smartphone showing a pending withdrawal status; the small black hardware wallet device
- расстановка: Gudini seated at the desk, first holding the smartphone then the hardware wallet
- камера: Camera is close over the desk at eye height; Gudini's hands move between the phone and the device as each screen changes.
- объекты: withdraw-request [change]: not submitted → submitted and held/blocked, not completed | hardware-wallet [change]: idle → actively signs and completes a transfer unopposed

**B8 · 70.4–76.4 с · eye_level · close** — события: ["not-your-keys"]
- действие: Gudini closes his fist around the hardware wallet device in the foreground while the laptop's balance screen glows softly out of focus behind him.
- ключевой момент: His fingers close firmly around the device, contrasted with the untouched balance figure still glowing on the laptop behind him.
- движение: Gudini's hand closes around the hardware wallet device, fingers wrapping fully around it, while the laptop screen with the balance figure stays lit but untouched in the soft background.
- механика: the fist closing around the device is the visible act of control; the untouched glowing balance behind represents the coins he cannot directly hold
- реквизит: the small black hardware wallet device; the laptop showing the balance figure, out of focus in the background
- расстановка: Gudini's hand in close foreground closing around the device; laptop with balance screen softly out of focus behind
- камера: Camera is close at desk height in front of Gudini's hand; the laptop screen glows softly out of focus behind as his fist closes around the device toward the camera.
- объекты: key-own [change]: not yet held → held firmly in the owner's own hand | key-exchange [keep]: held by the platform → still held by the platform, out of owner's reach

### Замечания проверок

- `readable-text` block: Сцена требует читаемый текст на экране или бумаге — Veo его не выводит (B4)
- `beat-multiple-events` warn: В одной сцене несколько событий: у них будет общий срок, показать их по отдельности нельзя — разложите на две сцены (B6)
- `object-state-describes-person` warn: Состояние предмета описывает позу человека, а не сам предмет — положение людей относится к сцене, а не к вещи (B4)
- `author-stretch-long` warn: Длинные куски без сцен (больше 12 с): 4.5–24.1 с, 54.2–70.4 с, 76.4–102.0 с
