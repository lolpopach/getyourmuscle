// G-PLAN's food table: what one serving of a Korean dish holds, and how a dish name — typed,
// read off the school lunch menu, or named by the photo model — finds its row.
//
// Why a table at all: the photo feature runs on a free vision model, and a small model that names
// a dish correctly still invents its calories. So the model only says WHAT is on the plate and HOW
// MUCH (servings); the numbers come from here, the same every time. A systematic error left in
// these rows does not move the plan either: the weekly check (gplan-adapt.js) reads the real
// weight trend, not these numbers.
//
// The values are typical single servings in a Korean home or school canteen (밥 1공기 210 g,
// 국 250 ml, a side dish's usual scoop, fruit around 100 g), rounded from common Korean nutrition
// references. Pure data and functions; no React.

// name[,alias…] | category | grams | kcal | protein | carbs | fat
// Categories: rice, noodle, soup, stew, main, side, kimchi, fruit, dairy, dessert, drink, free.
const ROWS = `
흰쌀밥,쌀밥,밥,공기밥,흰밥,백미밥|rice|210|310|6|68|1
흑미밥,잡곡밥,현미밥,보리밥,콩밥,오곡밥,귀리밥|rice|210|315|7|67|2
햇반,즉석밥|rice|210|315|5|70|1
볶음밥,계란볶음밥|rice|300|520|13|80|15
햄계란볶음밥,햄볶음밥|rice|300|560|16|80|19
새우계란볶음밥,새우볶음밥|rice|300|530|18|80|14
김치볶음밥,돈육김치볶음밥|rice|300|560|15|82|18
카레라이스,카레덮밥,카레|rice|400|600|14|100|15
짜장덮밥,짜장밥|rice|450|680|15|108|20
마파두부덮밥|rice|450|620|22|92|17
치킨마요덮밥|rice|400|720|27|95|25
참치마요덮밥,스팸참치마요덮밥,스팸마요덮밥|rice|400|700|22|92|26
제육덮밥|rice|450|720|28|98|23
불고기덮밥,소불고기덮밥|rice|450|650|25|98|16
오므라이스|rice|400|650|18|90|23
비빔밥,나물비빔밥|rice|450|560|15|92|14
돌솥비빔밥|rice|450|620|17|95|18
김밥|rice|230|420|12|68|11
참치김밥|rice|250|500|16|70|17
삼각김밥|rice|110|200|4|38|4
주먹밥|rice|120|210|5|40|3
유부초밥|rice|200|380|8|68|8
국밥,순대국밥|rice|650|650|30|75|22
덮밥|rice|450|620|20|95|16

크림스파게티,크림파스타|noodle|300|580|16|70|26
스파게티,토마토스파게티,파스타|noodle|300|500|15|80|13
우동|noodle|500|420|13|78|5
미니우동,미니어묵우동|noodle|250|210|7|38|3
새우튀김우동|noodle|450|480|15|75|13
중화볶음우동,볶음우동|noodle|350|520|16|78|15
라면|noodle|550|500|10|79|16
컵라면|noodle|300|300|6|42|12
짜장면|noodle|650|700|18|110|20
짬뽕|noodle|750|650|30|90|18
잔치국수|noodle|550|450|15|80|7
비빔국수|noodle|400|480|12|90|8
냉면,물냉면|noodle|700|550|17|100|8
쫄면,쫄면야채무침|noodle|200|300|7|60|3
메밀소바,소바|noodle|400|380|13|75|2
닭쌀국수,쌀국수|noodle|450|430|22|68|6
분짜|noodle|350|520|22|70|16
소면|noodle|100|140|4|28|1
당면|noodle|50|90|0|22|0
잡채,한식잡채|side|150|230|5|32|9
떡볶이,매콤떡볶이,고추장떡볶이,국물떡볶이|main|200|330|7|68|3
치즈떡볶이|main|200|380|10|68|7
궁중떡볶이,간장떡볶이|main|180|300|10|52|6

미역국,소고기미역국,미역장국|soup|250|90|7|4|5
콩나물국,김치콩나물국|soup|250|70|4|6|2
된장국,배추된장국,시금치된장국,열무된장국,아욱된장국,근대된장국|soup|250|80|5|8|3
무국,소고기무국|soup|250|90|7|5|5
어묵무국,어묵국,꼬치어묵국|soup|250|130|7|13|5
계란파국,계란국|soup|250|80|6|3|5
팽이장국,미소장국,유부장국,맑은장국|soup|250|50|3|5|2
조개시금치국,조개국,재첩국|soup|250|60|6|4|2
북어해장국,북엇국,해장국|soup|250|90|10|4|3
소고기샤브국,소고기두부탕국,두부국|soup|250|120|10|5|6
떡국,조랭이떡국|soup|300|330|12|58|5
떡만두국,조랭이떡만두국,만둣국,만두국|soup|350|370|14|60|8
육개장,소고기육개장|soup|300|170|14|10|8
설렁탕|soup|350|250|18|15|12
갈비탕,소갈비탕|soup|400|280|20|12|16
돼지국밥|soup|400|330|25|12|20
삼계탕,닭다리삼계탕|soup|400|350|30|15|18
짬뽕국,육해공짬뽕국|soup|300|150|10|12|6
감자탕|soup|400|450|30|20|26
순두부국|soup|250|110|8|5|6
국|soup|250|70|4|6|3

순두부찌개,돈육순두부찌개,조개순두부찌개,해물순두부찌개|stew|300|160|11|7|10
맑은순두부찌개|stew|300|120|9|5|7
된장찌개,소고기된장찌개,조개된장찌개,차돌된장찌개|stew|300|120|8|9|5
김치찌개,참치김치찌개,스팸김치찌개,돼지김치찌개|stew|300|180|11|8|11
부대찌개|stew|350|260|13|18|15
호박고추장찌개,고추장찌개|stew|300|110|5|12|4
청국장찌개,청국장|stew|300|140|11|9|6
동태찌개,생태찌개|stew|350|150|18|6|5
찌개|stew|300|150|9|9|8

소불고기,불고기,간장불고기,당면소불고기|main|150|270|20|12|15
제육볶음,고추장제육볶음,간장제육볶음,제육고추장볶음,제육김치볶음,돼지불고기|main|150|330|20|12|22
오삼불고기|main|150|280|20|13|16
오징어볶음|main|150|200|20|12|7
쭈꾸미볶음,주꾸미볶음,낙지볶음|main|150|190|20|12|6
돼지갈비찜,매운쪽갈비찜,쪽갈비찜,돼지갈비|main|180|350|20|14|23
소갈비찜,갈비찜|main|180|360|22|15|23
보쌈,수육|main|120|330|22|2|26
족발|main|120|300|28|2|20
삼겹살구이,삼겹살|main|100|330|17|0|29
삼겹살양념구이,양념삼겹살|main|100|360|17|6|29
대패삼겹숙주볶음,대패삼겹살볶음|main|150|300|14|6|25
목살양념구이,목살구이,목살|main|150|300|24|8|19
돈육김치찜,돈육김치조림,김치찜|main|180|280|18|8|19
돈육떡찜|main|180|280|15|30|11
돈까스,돈가스,돈까스브라운소스|main|130|400|18|30|23
치킨까스,치킨가스|main|130|380|20|28|21
생선까스,생선가스|main|110|300|14|25|16
치즈함박카츠|main|130|420|18|25|27
함박스테이크,함박|main|150|330|18|15|22
탕수육,치킨탕수육|main|180|400|15|45|17
떡갈비,떡갈비구이|main|100|230|13|12|14
안동찜닭,찜닭|main|250|330|25|30|11
닭볶음탕,닭도리탕|main|250|300|25|15|15
닭갈비|main|200|330|26|18|16
치즈닭갈비|main|200|380|28|18|21
닭다리살오븐구이,닭다리살구이,닭구이|main|150|280|26|3|18
닭강정|main|150|380|20|35|17
후라이드치킨,프라이드치킨,뿌링클치킨,순살치킨,양념치킨,치킨|main|150|400|24|18|25
닭윙봉튀김,간장닭윙봉튀김,윙봉,닭날개튀김|main|150|360|25|12|23
어니언크림치킨|main|150|380|22|20|23
치킨너겟,너겟|main|100|260|14|16|15
닭가슴살,닭가슴살구이,훈제닭가슴살|main|100|110|23|1|2
닭가슴살소시지|main|70|90|12|4|3
소세지떡강정,소떡소떡|main|150|380|9|45|18
마라상궈,소고기마라상궈|main|300|380|18|30|21
마파두부|main|200|220|13|8|15
고등어구이|main|120|280|22|0|20
연어구이,연어스테이크|main|120|250|24|0|17
연어,연어회|main|100|200|20|0|13
생선구이,삼치구이,가자미구이,조기구이|main|120|200|22|0|12
장조림,모둠장조림,소고기장조림|main|100|150|18|6|6
참치김치볶음|main|120|160|12|6|10
훈제오리|main|100|300|18|1|25
소고기구이,스테이크|main|150|380|38|0|25
햄버그,햄버거|main|220|500|25|45|25
샌드위치,햄치즈샌드위치|main|180|320|14|32|15
잠봉뵈르,잠봉샌드위치,잠봉뵈르샌드위치|main|200|480|18|55|20
핫도그|main|100|250|8|28|12
피자,콤비네이션피자|main|110|280|12|30|12
포케,닭가슴살포케|rice|450|700|53|82|13
닭가슴살샐러드,치킨샐러드|side|250|200|20|12|8

두부구이|main|100|110|9|3|7
두부강정|main|120|200|10|18|10
두부조림|main|120|130|10|5|8
온두부|main|150|100|9|2|5
두부|main|100|85|9|2|5
계란후라이,달걀후라이,계란프라이|main|50|90|6|1|7
삶은계란,삶은달걀,계란|main|50|75|7|1|5
계란말이|main|100|160|11|3|11
치즈계란말이|main|100|190|13|3|14
계란찜,맛살계란찜,달걀찜|main|120|100|8|2|7
스크램블에그|main|100|150|10|2|11
계란조림,메추리알조림,메추리알장조림|main|80|130|10|4|8
에그스카치|main|100|250|13|12|17
스모크햄전,햄전,동그랑땡|main|100|200|8|10|14
스모크햄야채볶음,소세지야채볶음,소시지야채볶음,햄야채볶음|main|120|200|7|10|15
소세지,소시지,비엔나소시지|main|60|170|7|4|14
스팸,스팸구이|main|60|180|8|2|16
고기만두찜,고기만두,만두,찐만두|main|120|250|10|30|10
교자만두튀김,군만두,만두튀김|main|120|300|8|30|16
순대,순대찜|main|120|270|10|36|9
순대야채볶음,순대볶음|main|200|330|12|40|13
어묵볶음,볼어묵볶음,어묵야채볶음|side|80|130|6|15|5
볼어묵강정,어묵강정|side|100|200|7|25|8
오징어부추전,해물파전,오징어김치전,파전,김치전,부추전|main|100|220|8|25|10
꼬지전,산적|main|100|200|9|14|12
견과류멸치볶음,멸치볶음,잔멸치볶음|side|30|120|8|9|6
오코노미야키|main|120|220|8|24|10
타코야키|main|100|220|7|28|8
스프링롤튀김,스프링롤|side|60|150|3|15|9

시금치나물,콩나물무침,숙주나물,부추무침,고사리나물,도라지무침,무생채,나물,무침|side|60|40|2|4|2
콩나물파채무침,파채무침|side|60|40|2|5|2
숙주맛살무침|side|70|60|4|5|3
오이무침,오이깍둑무침,중국식오이무침|side|60|30|1|5|1
단무지부추무침,단무지무침|side|50|30|1|6|1
모닝글로리볶음,공심채볶음|side|80|50|2|4|3
감자조림,알감자조림|side|100|110|2|22|2
감자채피망볶음,감자채볶음|side|100|100|2|14|4
감자버터구이,알감자버터구이,감자터버구이|side|120|150|3|22|6
해시브라운|side|60|150|2|15|9
감자튀김,양념감자튀김,스마일감자튀김,웨지감자|side|100|250|3|30|13
고구마맛탕|side|120|250|2|48|6
고구마범벅|side|120|220|4|45|3
고구마치즈크로켓,크로켓|side|80|220|5|25|11
고구마,군고구마,찐고구마|side|150|190|3|45|0
단호박꿀찜,단호박찜|side|100|100|2|24|0
옥수수버터구이,콘버터|side|80|120|3|20|4
옥수수|side|150|160|5|30|2
양배추샐러드,양상추샐러드,그린샐러드,사과코우슬로,코울슬로|side|80|70|1|7|5
마카로니샐러드|side|100|180|4|18|10
감자샐러드|side|100|150|3|15|9
김구이,김|side|5|25|2|1|2
아보카도|side|50|80|1|4|7
잡채밥|rice|450|650|14|105|19

배추김치,김치,포기김치|kimchi|40|15|1|3|0
깍두기,섞박지|kimchi|40|15|1|3|0
열무김치,총각김치,동치미,나박김치|kimchi|40|10|1|2|0
배추겉절이,겉절이|kimchi|40|20|1|4|0
볶음김치,김치볶음|kimchi|50|50|1|5|3
양념깻잎지,깻잎지,깻잎장아찌,장아찌|kimchi|20|20|1|3|0
오이피클,피클,할라피뇨|kimchi|30|20|0|5|0
단무지|kimchi|30|15|0|3|0

상추쌈,상추,쌈채소,깻잎|free|40|8|1|1|0
쌈장|free|15|30|2|4|1

바나나|fruit|100|90|1|23|0
사과|fruit|150|80|0|21|0
배|fruit|150|70|0|18|0
오렌지|fruit|130|60|1|15|0
감귤,귤|fruit|100|40|1|10|0
파인애플|fruit|100|50|1|13|0
용과|fruit|100|55|1|13|0
수박|fruit|200|60|1|15|0
멜론|fruit|150|55|1|13|0
망고|fruit|100|60|1|15|0
망고스틴|fruit|100|70|1|18|0
리치|fruit|100|65|1|17|0
포도|fruit|100|60|1|15|0
딸기|fruit|100|35|1|8|0
키위|fruit|100|60|1|15|1
방울토마토,대추방울토마토,토마토|fruit|100|20|1|4|0
토마토설탕|fruit|120|60|1|14|0
열대과일샐러드,과일샐러드,과일|fruit|120|70|1|17|0

우유,흰우유|dairy|200|130|6|10|8
초코우유,딸기우유,바나나우유,커피우유|dairy|200|170|5|25|5
두유|dairy|190|120|6|12|5
요구르트,요쿠르트,야쿠르트|dairy|65|50|1|11|0
마시는요거트,드링킹요거트|dairy|150|120|4|20|3
요거트,떠먹는요거트,블루베리요거트,딸기요거트,사과요거트|dairy|85|90|3|14|3
그릭요거트|dairy|100|100|9|6|5
치즈,슬라이스치즈|dairy|20|60|4|1|5
단백질음료,프로틴음료,프로틴드링크|drink|250|150|20|10|3
프로틴,프로틴쉐이크,단백질쉐이크,웨이프로틴|drink|30|120|24|3|2

꿀떡,떡,백설기,추석송편,송편,인절미,가래떡|dessert|100|230|4|52|1
미니브라우니,브라우니|dessert|40|170|2|20|9
마카롱|dessert|25|90|2|12|4
초코머핀,머핀|dessert|90|330|5|42|16
찹쌀도너츠링,찹쌀도너츠,도너츠,도넛|dessert|70|250|3|32|12
모닝빵,아코디언모닝빵|dessert|50|150|4|24|4
수제마늘빵,마늘빵|dessert|60|220|4|25|11
미니슈,슈크림|dessert|40|120|2|12|7
아이스모찌,찹쌀떡|dessert|50|120|2|22|3
꽃빵튀김|dessert|80|250|5|35|10
빵,식빵|dessert|60|160|5|30|2
케이크,조각케이크|dessert|100|330|5|40|17
쿠키|dessert|30|150|2|19|7
아이스크림|dessert|100|200|4|24|10
꿀|dessert|20|60|0|17|0

주스,오렌지주스,사과주스|drink|200|90|1|22|0
탄산음료,콜라,사이다|drink|250|110|0|27|0
이온음료|drink|250|60|0|15|0
라떼,카페라떼|drink|300|180|9|14|9
아메리카노,커피,녹차|drink|300|10|1|1|0
`

const CATS = new Set(['rice', 'noodle', 'soup', 'stew', 'main', 'side', 'kimchi', 'free', 'fruit', 'dairy', 'dessert', 'drink'])

/** Lowercase, no spaces or punctuation: '돈까스 * 브라운소스' and '돈까스*브라운소스' read alike. */
export const normName = s => String(s || '').toLowerCase().replace(/[\s·.,*&()[\]{}'"!?~:;/\\-]+/g, '')

export const FOODS = ROWS.trim().split('\n').filter(l => l.trim()).map(line => {
  const [names, cat, g, kcal, p, c, f] = line.split('|')
  const [name, ...aliases] = names.split(',')
  if (!CATS.has(cat)) throw new Error('foods.js: unknown category ' + cat)
  return { name, aliases, cat, g: +g, kcal: +kcal, p: +p, c: +c, f: +f }
})

const INDEX = new Map()
for (const food of FOODS) {
  for (const n of [food.name, ...food.aliases]) {
    const k = normName(n)
    if (!INDEX.has(k)) INDEX.set(k, food)
  }
}
// Longest first, so the suffix search below takes '치즈닭갈비' as 닭갈비, not 갈비.
const KEYS = [...INDEX.keys()].sort((a, b) => b.length - a.length)

/** Every name the table knows, for an input's suggestion list. */
export const foodNames = () => FOODS.map(f => f.name)

// The protein in a name: '제육김치볶음' is a pork dish whatever 김치볶음 alone would be.
const PROTEIN = /제육|돼지|돈육|삼겹|목살|보쌈|족발|갈비|돈까스|돈가스|탕수육|오삼|소고기|쇠고기|불고기|차돌|샤브|육개장|닭|치킨|윙봉|오리|오징어|새우|생선|고등어|연어|삼치|조개|해물|낙지|쭈꾸미|주꾸미|명태|북어|동태|코다리|참치|계란|달걀|메추리알|에그|두부|햄|소세지|소시지|스팸|베이컨|함박|미트|고기/

// What a name ends in says how it was cooked; with the protein above, that is a fair guess at a
// dish this table has never seen. [suffix, category, without protein, with protein], each
// [grams, kcal, protein, carbs, fat].
const METHODS = [
  ['볶음밥', 'rice', [300, 520, 12, 82, 15], [300, 560, 16, 80, 18]],
  ['덮밥', 'rice', [450, 600, 14, 100, 14], [450, 660, 24, 96, 19]],
  ['비빔밥', 'rice', [450, 560, 15, 92, 14], [450, 600, 20, 92, 16]],
  ['밥', 'rice', [210, 310, 6, 68, 1], [300, 480, 16, 72, 13]],
  ['국수', 'noodle', [500, 450, 14, 80, 7], [500, 500, 20, 80, 10]],
  ['우동', 'noodle', [500, 420, 13, 78, 5], [500, 460, 18, 78, 8]],
  ['면', 'noodle', [500, 480, 13, 85, 9], [500, 520, 20, 85, 11]],
  ['파스타', 'noodle', [300, 500, 15, 80, 13], [300, 560, 22, 78, 17]],
  ['찌개', 'stew', [300, 110, 5, 12, 4], [300, 170, 11, 8, 10]],
  ['전골', 'stew', [350, 180, 10, 12, 9], [350, 260, 20, 12, 15]],
  ['탕', 'soup', [300, 120, 6, 12, 5], [400, 280, 20, 12, 16]],
  ['국', 'soup', [250, 60, 3, 6, 2], [250, 100, 8, 5, 5]],
  ['까스', 'main', [110, 300, 8, 30, 16], [130, 380, 17, 28, 22]],
  ['카츠', 'main', [110, 300, 8, 30, 16], [130, 380, 17, 28, 22]],
  ['튀김', 'side', [80, 200, 3, 22, 11], [150, 360, 20, 20, 22]],
  ['강정', 'side', [100, 220, 4, 32, 9], [150, 360, 18, 32, 17]],
  ['전', 'side', [100, 180, 4, 24, 8], [100, 210, 9, 18, 11]],
  ['볶음', 'side', [80, 70, 2, 8, 4], [150, 280, 18, 12, 17]],
  ['구이', 'side', [120, 150, 3, 22, 6], [130, 260, 22, 5, 16]],
  ['조림', 'side', [100, 110, 2, 20, 2], [120, 160, 14, 8, 8]],
  ['찜', 'side', [120, 100, 3, 18, 2], [180, 290, 20, 14, 16]],
  ['무침', 'side', [60, 40, 2, 5, 2], [80, 90, 9, 6, 3]],
  ['나물', 'side', [60, 40, 2, 4, 2], [60, 40, 2, 4, 2]],
  ['샐러드', 'side', [80, 70, 1, 7, 5], [200, 180, 18, 10, 8]],
  ['김치', 'kimchi', [40, 15, 1, 3, 0], [120, 160, 12, 6, 10]],
  ['요거트', 'dairy', [85, 90, 3, 14, 3], [85, 90, 3, 14, 3]],
  ['우유', 'dairy', [200, 150, 6, 15, 6], [200, 150, 6, 15, 6]],
  ['빵', 'dessert', [60, 180, 4, 28, 6], [120, 300, 12, 32, 14]],
  ['떡', 'dessert', [100, 230, 4, 52, 1], [100, 230, 4, 52, 1]],
  ['주스', 'drink', [200, 90, 1, 22, 0], [200, 90, 1, 22, 0]],
]
const asFood = (name, cat, [g, kcal, p, c, f]) => ({ name, aliases: [], cat, g, kcal, p, c, f })

/**
 * The table's row for a dish name, and how sure the match is:
 *   'exact'   — the name or one of its spellings is in the table
 *   'similar' — the name ends in a dish the table has ('치즈닭갈비' → 닭갈비)
 *   'guess'   — built from how the name says it was cooked and whether it holds meat, fish,
 *               egg or tofu; or a plain side dish when nothing in the name says more
 * Returns { food, how } or null for an empty name. `food` is one serving.
 */
export function findFood(raw) {
  const n = normName(raw)
  if (!n) return null
  const hit = INDEX.get(n)
  if (hit) return { food: hit, how: 'exact' }

  const protein = PROTEIN.test(n)
  for (const k of KEYS) {
    if (k.length < 2 || k.length >= n.length || !n.endsWith(k)) continue
    const food = INDEX.get(k)
    // '제육김치볶음' ends in 김치볶음, but the pork decides what it is.
    if (protein && !PROTEIN.test(k) && food.p < 8) break
    return { food, how: 'similar' }
  }

  const m = METHODS.find(([suffix]) => n.endsWith(suffix)) || METHODS.find(([suffix]) => suffix.length > 1 && n.includes(suffix))
  // A cooked side dish with meat, fish, egg or tofu in it is the meal's protein dish.
  if (m) return { food: asFood(String(raw).trim(), protein && ['side', 'kimchi'].includes(m[1]) ? 'main' : m[1], protein ? m[3] : m[2]), how: 'guess' }
  return { food: asFood(String(raw).trim(), protein ? 'main' : 'side', protein ? [120, 230, 17, 8, 14] : [80, 80, 2, 10, 3]), how: 'guess' }
}

const r1 = v => Math.round(v * 10) / 10

/** One food times a number of servings, rounded the way the meal log stores it. */
export function scaled(food, servings = 1) {
  const s = Number.isFinite(+servings) ? Math.max(0, +servings) : 1
  return { kcal: Math.round(food.kcal * s), p: r1(food.p * s), c: r1(food.c * s), f: r1(food.f * s) }
}

/** Sum of { kcal, p, c, f } rows, rounded. */
export function sumNutrition(rows) {
  const t = rows.reduce((a, x) => ({ kcal: a.kcal + (+x.kcal || 0), p: a.p + (+x.p || 0), c: a.c + (+x.c || 0), f: a.f + (+x.f || 0) }), { kcal: 0, p: 0, c: 0, f: 0 })
  return { kcal: Math.round(t.kcal), p: Math.round(t.p), c: Math.round(t.c), f: Math.round(t.f) }
}
