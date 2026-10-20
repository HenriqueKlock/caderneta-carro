"""Testes do gerador de postos com arquivos fictícios (nenhum dado real)."""
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
import unittest

from openpyxl import Workbook

sys.path.insert(0, os.path.dirname(__file__))
import postos  # noqa: E402

AQUI = os.path.dirname(os.path.abspath(__file__))


def xlsx(path, rows):
    wb = Workbook()
    ws = wb.active
    for r in rows:
        ws.append(r)
    wb.save(path)


class Unidades(unittest.TestCase):
    def test_norm_e_cnpj(self):
        self.assertEqual(postos.norm('Município'), 'MUNICIPIO')
        self.assertEqual(postos.norm('CNPJ/CPF'), 'CNPJCPF')
        self.assertEqual(postos.cnpj_of('12.345.678/0001-90'), '12345678000190')
        self.assertEqual(postos.cnpj_of('123'), '')

    def test_produtos(self):
        self.assertEqual(postos.product_code('GASOLINA COMUM'), 'gc')
        self.assertEqual(postos.product_code('GASOLINA ADITIVADA'), 'ga')
        self.assertEqual(postos.product_code('ETANOL HIDRATADO'), 'et')
        self.assertEqual(postos.product_code('OLEO DIESEL S10'), 'd10')
        self.assertIsNone(postos.product_code('GLP P13'))

    def test_preco_e_data(self):
        self.assertEqual(postos.to_price('6,59'), 6.59)
        self.assertEqual(postos.to_price(4.29), 4.29)
        self.assertIsNone(postos.to_price('105,00'))
        self.assertEqual(postos.to_date('08/10/2026'), '2026-10-08')
        self.assertEqual(postos.to_date(dt.datetime(2026, 10, 8, 10)), '2026-10-08')

    def test_rua(self):
        self.assertEqual(postos.clean_street('AV. DAS FLORES, Nº 120'), 'AVENIDA DAS FLORES')
        self.assertEqual(postos.clean_street('ROD SC 401 KM 5'), 'RODOVIA SC-401 KM 5')
        self.assertEqual(postos.clean_street('R  JOAO   PINTO'), 'RUA JOAO PINTO')

    def test_bairro(self):
        self.assertEqual(postos.clean_bairro('RIB DA ILHA'), 'RIBEIRAO DA ILHA')
        self.assertTrue(postos.same_name('Ribeirão da Ilha', 'RIBEIRAO DA ILHA'))
        self.assertTrue(postos.same_name('Trindade', 'TRINDADE'))
        self.assertFalse(postos.same_name('Florianópolis', 'RIBEIRAO DA ILHA'))
        self.assertEqual(postos.display_flag('BANDEIRA BRANCA'), 'Bandeira branca')

    def test_titulo(self):
        self.assertEqual(postos.title('POSTO DA LAGOA LTDA'), 'Posto da Lagoa LTDA')


class Geocodificacao(unittest.TestCase):
    def geo(self, respostas):
        g = postos.Geo({}, 99)
        g._q = lambda params: respostas.pop(0) if respostas else []
        return g

    def test_bairro_que_volta_a_cidade_e_recusado(self):
        cidade = {'lat': '-27.59', 'lon': '-48.55', 'addresstype': 'city', 'name': 'Florianópolis', 'boundingbox': ['-27.6', '-27.58', '-48.56', '-48.54'],
                  'address': {'city': 'Florianópolis', 'state': 'Santa Catarina'}}
        p = {'uf': 'SC', 'mun': 'FLORIANOPOLIS', 'end': 'RUA X', 'num': '10', 'bairro': 'RIB DA ILHA'}
        self.assertIsNone(self.geo([[], [], [cidade]]).locate(p))

    def test_numero_na_cidade_certa(self):
        outra = {'lat': '-26.9', 'lon': '-48.6', 'boundingbox': ['0', '0.001', '0', '0.001'], 'address': {'town': 'Itapema', 'state': 'Santa Catarina'}}
        certa = {'lat': '-27.5912345', 'lon': '-48.5', 'boundingbox': ['0', '0.001', '0', '0.001'], 'address': {'city': 'Florianópolis', 'state': 'Santa Catarina'}}
        p = {'uf': 'SC', 'mun': 'FLORIANOPOLIS', 'end': 'RUA X', 'num': '10', 'bairro': ''}
        self.assertEqual(self.geo([[outra, certa]]).locate(p), (-27.59123, -48.5, 'n', 'Florianópolis'))


class Fluxo(unittest.TestCase):
    def test_gera_json(self):
        with tempfile.TemporaryDirectory() as d:
            cad = os.path.join(d, 'cad.csv')
            with open(cad, 'w', encoding='cp1252') as f:
                f.write('CODIGOISIMP;AUTORIZACAO;DATAPUBLICACAO;RAZAOSOCIAL;CNPJ;ENDERECO;COMPLEMENTO;BAIRRO;CEP;UF;MUNICIPIO;BANDEIRA;DATAVINCULACAO\n')
                f.write('1;X;01/01/2001;AUTO POSTO EXEMPLO UM LTDA;11111111000111;AV EXEMPLO,  100;;CENTRO;88000000;SC;FLORIANÓPOLIS;BRANCA;01/01/2020\n')
                f.write('2;X;01/01/2001;COMERCIO DE COMBUSTIVEIS DOIS EIRELI;22222222000122;R TESTE,  S/N;;TRINDADE;88000001;SC;FLORIANÓPOLIS;RAIZEN;01/01/2020\n')
                f.write('3;X;01/01/2001;POSTO DE OUTRO ESTADO;33333333000133;R LONGE,  1;;CENTRO;01000000;SP;SÃO PAULO;VIBRA;01/01/2020\n')
            lpc = os.path.join(d, 'lpc.xlsx')
            xlsx(lpc, [
                ['Levantamento de preços — revendas'], [],
                ['CNPJ', 'RAZÃO', 'FANTASIA', 'ENDEREÇO', 'NÚMERO', 'COMPLEMENTO', 'BAIRRO', 'CEP', 'MUNICÍPIO', 'ESTADO', 'BANDEIRA', 'PRODUTO', 'UNIDADE DE MEDIDA', 'PREÇO DE REVENDA', 'DATA DA COLETA'],
                ['11.111.111/0001-11', 'AUTO POSTO EXEMPLO UM LTDA', 'POSTO EXEMPLO UM', 'AV EXEMPLO', '100', '', 'CENTRO', '88000-000', 'FLORIANOPOLIS', 'SC', 'BRANCA', 'GASOLINA COMUM', 'R$/l', 6.59, dt.datetime(2026, 10, 7)],
                ['11.111.111/0001-11', 'AUTO POSTO EXEMPLO UM LTDA', 'POSTO EXEMPLO UM', 'AV EXEMPLO', '100', '', 'CENTRO', '88000-000', 'FLORIANOPOLIS', 'SC', 'BRANCA', 'ETANOL HIDRATADO', 'R$/l', '4,49', '08/10/2026'],
                ['11.111.111/0001-11', 'AUTO POSTO EXEMPLO UM LTDA', 'POSTO EXEMPLO UM', 'AV EXEMPLO', '100', '', 'CENTRO', '88000-000', 'FLORIANOPOLIS', 'SC', 'BRANCA', 'GLP', 'R$/13kg', 110, '08/10/2026'],
                ['44.444.444/0001-44', 'POSTO SO NO LPC', 'POSTO QUATRO', 'R NOVA', '5', '', 'CENTRO', '88000-002', 'FLORIANOPOLIS', 'SC', 'SHELL', 'GASOLINA COMUM', 'R$/l', 6.79, '06/10/2026'],
            ])
            fisc = os.path.join(d, 'fisc.xlsx')
            xlsx(fisc, [
                ['UF', 'Município', 'Bairro', 'Endereço', 'CNPJ/CPF', 'Agente Econômico', 'Segmento Fiscalizado', 'DATA DO DF', 'Número do Documento', 'Procedimento de Fiscalização', 'Resultado'],
                ['SC', 'FLORIANOPOLIS', 'TRINDADE', 'R TESTE', '22.222.222/0001-22', 'X', 'Revenda de Combustíveis', dt.datetime(2026, 3, 2), 1, 'Auto de Infração', 'Bomba medidora com volume a menor'],
                ['SC', 'FLORIANOPOLIS', 'TRINDADE', 'R TESTE', '22.222.222/0001-22', 'X', 'Revenda de Combustíveis', dt.datetime(2026, 3, 2), 1, 'Boletim de Fiscalização', 'Fiscalização de rotina'],
                ['SC', 'FLORIANOPOLIS', 'CENTRO', 'AV EXEMPLO', '11.111.111/0001-11', 'X', 'Revenda de Combustíveis', dt.datetime(2025, 1, 10), 2, 'Boletim de Fiscalização', 'Nada consta'],
                ['SC', 'FLORIANOPOLIS', 'CENTRO', 'AV EXEMPLO', '11.111.111/0001-11', 'X', 'Revenda de Combustíveis', dt.datetime(2019, 1, 10), 3, 'Auto de Interdição', 'Antigo, fora da janela'],
                ['SC', 'FLORIANOPOLIS', 'CENTRO', 'X', '11.111.111/0001-11', 'X', 'Revenda de GLP', dt.datetime(2026, 2, 1), 9, 'Auto de Interdição', 'GLP não conta'],
                ['SP', 'SAO PAULO', 'CENTRO', 'R LONGE', '33.333.333/0001-33', 'X', 'Revenda de Combustíveis', dt.datetime(2026, 3, 2), 4, 'Auto de Interdição', 'Outro estado'],
            ])
            est = os.path.join(d, 'estado')
            os.makedirs(est)
            # Coordenadas já em cache (o teste não consulta a internet)
            cache = {}
            for cnpj, (end, num, bairro) in {
                '11111111000111': ('AV EXEMPLO', '100', 'CENTRO'),
                '22222222000122': ('R TESTE', 'S/N', 'TRINDADE'),
            }.items():
                cache[cnpj] = {'k': postos.addr_key({'end': end, 'num': num, 'bairro': bairro, 'mun': 'FLORIANÓPOLIS', 'uf': 'SC'}), 'em': '2026-10-01', 'la': -27.59, 'lo': -48.54, 'p': 'r'}
            with open(os.path.join(est, 'geocache.json'), 'w') as f:
                json.dump(cache, f)
            subprocess.run([sys.executable, os.path.join(AQUI, 'postos.py'), '--estado', est, '--uf', 'SC', '--cad', cad, '--lpc', lpc, '--fisc', fisc, '--sem-geo', '--hoje', '2026-10-20'], check=True, capture_output=True)
            with open(os.path.join(est, 'postos-SC.json'), encoding='utf-8') as f:
                doc = json.load(f)
            by = {p['c']: p for p in doc['postos']}
            self.assertEqual(set(by), {'11111111000111', '22222222000122'})  # o 44… não tem coordenada; SP fica fora
            um = by['11111111000111']
            self.assertEqual(um['n'], 'Posto Exemplo Um')
            self.assertEqual(um['pr'], {'gc': [6.59, '2026-10-07'], 'et': [4.49, '2026-10-08']})
            self.assertEqual(um['f']['n'], 1)
            self.assertEqual(um['f']['ev'], [])  # boletim conta como visita, não como ocorrência; 2019 fora da janela
            dois = by['22222222000122']
            self.assertEqual(dois['n'], 'Comercio de Combustiveis Dois')
            self.assertEqual(dois['b'], 'Shell')
            self.assertEqual(dois['e'], 'Rua Teste')
            self.assertEqual(um['e'], 'Avenida Exemplo, 100')
            self.assertEqual(um['b'], 'Bandeira branca')
            self.assertEqual(dois['f']['ev'], [['2026-03-02', 'I', 'Bomba medidora com volume a menor']])
            self.assertEqual(doc['contagem']['cadastro'], 3)
            self.assertEqual(doc['contagem']['sem_local'], 1)


if __name__ == '__main__':
    unittest.main()
